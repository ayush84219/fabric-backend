import { Material, Room, Shelf, AuditLog, DyeingMaterial, sequelize } from '../models/index.js';
import { Op } from 'sequelize';
import { cache } from '../utils/cache.js';

// Audit Log Helper
export async function addAuditLog(action, detail, user = 'Admin User', type = 'info') {
  const now = new Date();
  const dateStr = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
  await AuditLog.create({
    action,
    detail,
    user,
    date: dateStr,
    type
  });
}

// Auto Location Assignment Logic based on DB Tables
export const findAvailableLocation = async (category) => {
  try {
    const rooms = await Room.findAll();
    const room = rooms.find(r => r.category === category) || rooms[0];
    if (!room) return 'A-A-R1';

    const shelves = await Shelf.findAll({ where: { room: room.id } });
    if (shelves.length === 0) return `${room.id}-A-R1`;

    // Sum rolls currently in each shelf to check usage (from both tables)
    const materialsInRoom = await Material.findAll({
      where: { location: shelves.map(s => s.id) }
    });
    const dyeingInRoom = await DyeingMaterial.findAll({
      where: { location: shelves.map(s => s.id) }
    });

    const shelfUsedMap = {};
    materialsInRoom.forEach(m => {
      shelfUsedMap[m.location] = (shelfUsedMap[m.location] || 0) + (m.rolls || 0);
    });
    dyeingInRoom.forEach(dm => {
      shelfUsedMap[dm.location] = (shelfUsedMap[dm.location] || 0) + (dm.rolls || 1);
    });

    const available = shelves.find(s => {
      const used = shelfUsedMap[s.id] || 0;
      return (s.capacity - used) > 0;
    });

    return available ? available.id : shelves[0].id;
  } catch (e) {
    return 'A-A-R1';
  }
};

export const getMaterials = async (req, res) => {
  try {
    const { search, category, status, location } = req.query;
    const where = {};

    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { code: { [Op.like]: `%${search}%` } },
        { location: { [Op.like]: `%${search}%` } }
      ];
    }
    if (category && category !== 'All') {
      where.category = category;
    }
    if (status && status !== 'All') {
      where.status = status;
    }
    if (location) {
      where.location = location;
    }

    const materials = await Material.findAll({
      where,
      order: [['id', 'DESC']]
    });
    res.json(materials);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const getNextBarcodeId = async (transaction = null) => {
  const [materialResult] = await sequelize.query(
    "SELECT MAX(CAST(SUBSTRING(code, 4) AS UNSIGNED)) as max_num FROM Materials WHERE code LIKE 'MAT%';",
    { transaction }
  );
  const [dyeingResult] = await sequelize.query(
    "SELECT MAX(CAST(SUBSTRING(barcodeId, 4) AS UNSIGNED)) as max_num FROM DyeingMaterials WHERE barcodeId LIKE 'MAT%';",
    { transaction }
  );

  const maxMat = (materialResult && materialResult[0] && materialResult[0].max_num) ? parseInt(materialResult[0].max_num) : 0;
  const maxDyeing = (dyeingResult && dyeingResult[0] && dyeingResult[0].max_num) ? parseInt(dyeingResult[0].max_num) : 0;

  const lastId = Math.max(maxMat, maxDyeing);
  const nextId = lastId + 1;
  const barcodeId = `MAT${String(nextId).padStart(5, '0')}`;

  return {
    barcodeId,
    numericId: nextId,
    lastId
  };
};

export const checkShelfCapacity = async (shelfId, additionalRolls, excludeMaterialId = null, transaction = null) => {
  if (!shelfId) return;

  const shelf = await Shelf.findByPk(shelfId, { transaction });
  if (!shelf) {
    throw new Error(`Shelf "${shelfId}" does not exist.`);
  }

  // Find all materials and dyeing materials in this shelf
  const where = { location: shelfId };
  if (excludeMaterialId) {
    where.id = { [Op.ne]: excludeMaterialId };
  }
  const materials = await Material.findAll({ where, transaction });
  const dyeingMaterials = await DyeingMaterial.findAll({ where: { location: shelfId }, transaction });

  const materialUsed = materials.reduce((sum, m) => sum + (m.rolls || 0), 0);
  const dyeingUsed = dyeingMaterials.reduce((sum, dm) => sum + (dm.rolls || 1), 0);
  const currentlyUsed = materialUsed + dyeingUsed;

  const remaining = shelf.capacity - currentlyUsed;
  if (additionalRolls > remaining) {
    throw new Error(`Space is full! Shelf ${shelfId} has only ${remaining} rolls available, but attempted to add/set to ${additionalRolls} rolls.`);
  }
};

export const addMaterial = async (req, res) => {
  try {
    const { barcodeId: newCode } = await getNextBarcodeId();
    
    let location = req.body.location;
    if (!location) {
      location = await findAvailableLocation(req.body.category);
    }

    const rollsVal = parseInt(req.body.rolls) || 0;
    await checkShelfCapacity(location, rollsVal);

    const material = await Material.create({
      ...req.body,
      code: newCode,
      location
    });

    cache.delete('settings_data');

    await addAuditLog('New Material Created', `${material.code}: ${material.name} added`, 'Admin User', 'create');
    res.json(material);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const updateMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const material = await Material.findByPk(id);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    
    const targetLocation = req.body.location !== undefined ? req.body.location : material.location;
    const targetRolls = req.body.rolls !== undefined ? parseInt(req.body.rolls) || 0 : material.rolls;
    await checkShelfCapacity(targetLocation, targetRolls, material.id);

    await material.update(req.body);
    cache.delete('settings_data');
    res.json(material);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const material = await Material.findByPk(id);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    
    await material.destroy();
    cache.delete('settings_data');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

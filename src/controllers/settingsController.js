import { Room, Rack, Shelf, Supplier, AuditLog, Material, DyeingMaterial, sequelize } from '../models/index.js';
import { addAuditLog } from './materialController.js';
import { Op } from 'sequelize';
import { cache } from '../utils/cache.js';

export const getSettingsData = async (req, res) => {
  try {
    const cachedData = cache.get('settings_data');
    if (cachedData) {
      return res.json(cachedData);
    }

    const [rooms, racks, shelves, materialUsage, dyeingUsage, suppliers, auditLog] = await Promise.all([
      Room.findAll(),
      Rack.findAll(),
      Shelf.findAll(),
      Material.findAll({
        attributes: [
          'location',
          [sequelize.fn('SUM', sequelize.col('rolls')), 'used']
        ],
        where: {
          location: { [Op.ne]: null }
        },
        group: ['location'],
        raw: true
      }),
      DyeingMaterial.findAll({
        attributes: [
          'location',
          [sequelize.fn('COUNT', sequelize.col('id')), 'used']
        ],
        where: {
          location: { [Op.ne]: null }
        },
        group: ['location'],
        raw: true
      }),
      Supplier.findAll(),
      AuditLog.findAll({ order: [['id', 'DESC']], limit: 200 })
    ]);

    const shelfUsedMap = {};
    materialUsage.forEach(row => {
      if (row.location) shelfUsedMap[row.location] = (shelfUsedMap[row.location] || 0) + Number(row.used || 0);
    });
    dyeingUsage.forEach(row => {
      if (row.location) shelfUsedMap[row.location] = (shelfUsedMap[row.location] || 0) + Number(row.used || 0);
    });

    const enrichedShelves = shelves.map(s => {
      const data = s.toJSON();
      data.used = shelfUsedMap[s.id] || 0;
      return data;
    });

    // Extract unique floor list from Rooms
    const floors = [...new Set(rooms.map(r => r.floor).filter(Boolean))];

    const result = {
      rooms,
      racks,
      shelves: enrichedShelves,
      suppliers,
      auditLog,
      floors
    };

    cache.set('settings_data', result, 24 * 60 * 60 * 1000); // 24 hours TTL, cache is invalidated on mutations
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Rooms
export const addRoom = async (req, res) => {
  try {
    const room = await Room.create(req.body);
    cache.delete('settings_data');
    await addAuditLog('Room Added', `Room ${room.name} (${room.id}) added`, 'Admin User', 'create');
    res.json(room);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const updateRoom = async (req, res) => {
  try {
    const { id } = req.params;
    const room = await Room.findByPk(id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    
    await room.update(req.body);
    cache.delete('settings_data');
    await addAuditLog('Room Updated', `Room ${id} details updated`, 'Admin User', 'create');
    res.json(room);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteRoom = async (req, res) => {
  try {
    const { id } = req.params;
    const hasRacks = await Rack.findOne({ where: { room: id } });
    if (hasRacks) {
      return res.status(400).json({ error: `Cannot delete room ${id}: there are racks inside it.` });
    }
    const room = await Room.findByPk(id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    
    await room.destroy();
    cache.delete('settings_data');
    await addAuditLog('Room Removed', `Room ${id} deleted`, 'Admin User', 'delete');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Racks
export const addRack = async (req, res) => {
  try {
    const rack = await Rack.create(req.body);
    cache.delete('settings_data');
    await addAuditLog('Rack Added', `Rack ${rack.name} added to Room ${rack.room}`, 'Admin User', 'create');
    res.json(rack);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteRack = async (req, res) => {
  try {
    const { id } = req.params;
    const hasMaterials = await Material.findOne({
      where: { location: { [Op.like]: `${id}%` } }
    });
    const hasDyeing = await DyeingMaterial.findOne({
      where: { location: { [Op.like]: `${id}%` } }
    });
    if (hasMaterials || hasDyeing) {
      return res.status(400).json({ error: `Cannot delete Rack ${id}: materials are stored in shelves on this rack.` });
    }
    
    await Shelf.destroy({ where: { rack: id } });
    const rack = await Rack.findByPk(id);
    if (rack) await rack.destroy();
    
    cache.delete('settings_data');

    await addAuditLog('Rack Removed', `Rack ${id} and its shelves were deleted`, 'Admin User', 'delete');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Shelves
export const addShelf = async (req, res) => {
  try {
    const shelf = await Shelf.create(req.body);
    cache.delete('settings_data');
    await addAuditLog('Shelf Added', `Shelf ${shelf.id} added to Rack ${shelf.rack}`, 'Admin User', 'create');
    res.json(shelf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteShelf = async (req, res) => {
  try {
    const { id } = req.params;
    const hasMaterials = await Material.findOne({ where: { location: id } });
    const hasDyeing = await DyeingMaterial.findOne({ where: { location: id } });
    if (hasMaterials || hasDyeing) {
      return res.status(400).json({ error: `Cannot delete Shelf ${id}: materials are stored on this shelf.` });
    }
    const shelf = await Shelf.findByPk(id);
    if (shelf) await shelf.destroy();
    
    cache.delete('settings_data');
    await addAuditLog('Shelf Removed', `Shelf ${id} was deleted`, 'Admin User', 'delete');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Suppliers
export const addSupplier = async (req, res) => {
  try {
    const sup = await Supplier.create(req.body);
    cache.delete('settings_data');
    res.json(sup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const sup = await Supplier.findByPk(id);
    if (!sup) return res.status(404).json({ error: 'Supplier not found' });
    
    await sup.update(req.body);
    cache.delete('settings_data');
    res.json(sup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const sup = await Supplier.findByPk(id);
    if (sup) await sup.destroy();
    cache.delete('settings_data');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

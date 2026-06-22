class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  set(key, value, ttlMs = 0) {
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    this.store.set(key, { value, expiresAt });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  // Stale-While-Revalidate pattern helper
  async swr(key, ttlMs, fetchFn) {
    const entry = this.store.get(key);
    const now = Date.now();

    if (entry) {
      const isExpired = entry.expiresAt > 0 && now > entry.expiresAt;
      if (!isExpired) {
        // Cache is fresh, return immediately
        return entry.value;
      }
      
      // Cache is stale. Trigger background fetch, but return stale value immediately
      console.log(`[Cache SWR] Cache stale for key: ${key}. Serving stale and fetching in background.`);
      
      // Run fetchFn in background, avoiding overlapping sync tasks
      if (!this.get(`${key}_syncing`)) {
        this.set(`${key}_syncing`, true, 60000); // 1 minute lock to prevent multiple concurrent syncs
        fetchFn()
          .then(freshValue => {
            this.set(key, freshValue, ttlMs);
            console.log(`[Cache SWR] Background sync completed for key: ${key}`);
          })
          .catch(err => {
            console.error(`[Cache SWR] Background sync failed for key: ${key}`, err);
          })
          .finally(() => {
            this.delete(`${key}_syncing`);
          });
      }
      
      return entry.value;
    }

    // Cache miss. Must fetch synchronously this time.
    console.log(`[Cache SWR] Cache miss for key: ${key}. Fetching synchronously.`);
    const freshValue = await fetchFn();
    this.set(key, freshValue, ttlMs);
    return freshValue;
  }
}

export const cache = new MemoryCache();

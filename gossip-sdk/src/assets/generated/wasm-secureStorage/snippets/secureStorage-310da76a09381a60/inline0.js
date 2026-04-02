let _db = null;

export async function idbOpen() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('secureStorage', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('blocks');
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readonly');
    const store = tx.objectStore('blocks');
    const keys = store.getAllKeys();
    const vals = store.getAll();
    tx.oncomplete = () => resolve({ keys: keys.result, vals: vals.result });
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbPutBatch(entries) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readwrite');
    const store = tx.objectStore('blocks');
    for (const [key, value] of entries) {
      store.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeleteAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readwrite');
    const store = tx.objectStore('blocks');
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbHasAnyData() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readonly');
    const store = tx.objectStore('blocks');
    const req = store.count();
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror = () => reject(req.error);
  });
}

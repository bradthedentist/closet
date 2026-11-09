// Tiny IndexedDB key-value store for the device cache (catalog copy, thumbnails/cutouts by Drive file ID, pending
// imports). Drive stays authoritative; clearing this only makes the next start slower.
export function openKV(dbName) {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('blobs'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (store, mode, fn) => { const d = await db(); return await new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  const api = (store) => ({
    get: (k) => tx(store, 'readonly', (s) => s.get(k)),
    set: (k, v) => tx(store, 'readwrite', (s) => s.put(v, k)),
    delete: (k) => tx(store, 'readwrite', (s) => s.delete(k)),
    keys: () => tx(store, 'readonly', (s) => s.getAllKeys()),
    clear: () => tx(store, 'readwrite', (s) => s.clear()),
  });
  return { kv: api('kv'), blobs: api('blobs') };
}
export function memoryKV() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => { m.delete(k); }, keys: async () => [...m.keys()], clear: async () => m.clear(), _map: m };
}

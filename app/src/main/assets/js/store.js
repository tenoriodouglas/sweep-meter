// Measurement history in IndexedDB (falls back to memory when unavailable).

const DB_NAME = "sweepmeter", STORE = "measurements";
const memory = new Map();
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return fn(db ? db.transaction(STORE, mode).objectStore(STORE) : null);
}

const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const put = m => tx("readwrite", s => (s ? req(s.put(m)) : memory.set(m.id, m)));
export const get = id => tx("readonly", s => (s ? req(s.get(id)) : memory.get(id)));
export const del = id => tx("readwrite", s => (s ? req(s.delete(id)) : memory.delete(id)));
export const clear = () => tx("readwrite", s => (s ? req(s.clear()) : memory.clear()));

/** All measurements, newest first. */
export async function list() {
  const all = await tx("readonly", s => (s ? req(s.getAll()) : [...memory.values()]));
  return (all || []).sort((a, b) => b.date - a.date);
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

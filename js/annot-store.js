// fix-2
// Module "annot-store": aantekeningen lokaal bewaren in IndexedDB, per document.
// Sleutel = pdf.js-vingerafdruk(ken). Er wordt GEEN PDF-inhoud opgeslagen, alleen de aantekeningen.
// Alles faalt "zacht": zonder IndexedDB (privémodus, quota) werkt tekenen gewoon door.
import { sanitizeItem } from './annot-model.js';

const DB_NAME = 'pdfreader';
const DB_VERSION = 1;
const STORE = 'annotations';
export const MAX_DOCS = 50;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('geen IndexedDB')); return; }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('geblokkeerd'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('afgebroken'));
  }));
}

const req2p = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/** Laadt de aantekeningen van een document (lege lijst als er niets is). */
export async function loadAnnotations(key) {
  if (!key) return [];
  const rec = await tx('readonly', (s) => req2p(s.get(key)));
  if (!rec || !Array.isArray(rec.items)) return [];
  return rec.items.map(sanitizeItem).filter(Boolean);
}

/**
 * Bewaart (of verwijdert bij een lege lijst) de aantekeningen van een document.
 * exported = de huidige stand is al als PDF opgeslagen (mag dan als eerste afvallen).
 */
export async function saveAnnotations(key, items, { exported = false } = {}) {
  if (!key) return;
  await tx('readwrite', async (s) => {
    if (!items.length) { await req2p(s.delete(key)); return; }
    await req2p(s.put({ key, items, n: items.length, t: Date.now(), exported }));
  });
  if (items.length) await prune(key);
}

export async function markExported(key) {
  if (!key) return;
  await tx('readwrite', async (s) => {
    const rec = await req2p(s.get(key));
    if (rec) { rec.exported = true; await req2p(s.put(rec)); }
  });
}

/**
 * Maximaal MAX_DOCS documenten. De oudste vallen af, maar alleen als hun aantekeningen
 * al in een opgeslagen PDF staan; niet-opgeslagen werk wordt nooit stil verwijderd.
 */
async function prune(currentKey) {
  await tx('readwrite', async (s) => {
    const all = await req2p(s.getAll());
    if (all.length <= MAX_DOCS) return;
    const candidates = all.filter((r) => r.key !== currentKey && r.exported).sort((a, b) => a.t - b.t);
    let excess = all.length - MAX_DOCS;
    for (const r of candidates) {
      if (excess <= 0) break;
      await req2p(s.delete(r.key));
      excess--;
    }
  });
}

/** Aantal documenten en aantekeningen (voor de bevestiging bij "Geschiedenis wissen"). */
export async function countAll() {
  try {
    const all = await tx('readonly', (s) => req2p(s.getAll()));
    return { docs: all.length, items: all.reduce((n, r) => n + (r.n || 0), 0) };
  } catch {
    return { docs: 0, items: 0 };
  }
}

export async function clearAll() {
  await tx('readwrite', (s) => req2p(s.clear()));
}

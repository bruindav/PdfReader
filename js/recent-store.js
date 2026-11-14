// fix-6
// Module "recent-store": de laatst geopende documenten (max. 6) in IndexedDB, alleen op dit toestel.
// Eigen database (los van de aantekeningen), twee stores:
//   "recent": metagegevens + kleine miniatuur (Blob)  {key, name, size, openedAt, pages, locked, thumb}
//   "bytes":  een KOPIE van de originele PDF-bytes (Blob), sleutel = key
// Zo blijft een PDF uit bijv. een bank-app (content://-adres waarvan de leesrechten verlopen) later te openen.
// Wachtwoorden worden nooit bewaard; van beveiligde PDF's wordt de originele (versleutelde) kopie bewaard.

const DB_NAME = 'pdfreader-recent';
const DB_VERSION = 1;
const META = 'recent';
const BYTES = 'bytes';
export const MAX_RECENT = 6;
export const MAX_BYTES = 50 * 1024 * 1024; // grotere PDF's worden niet bewaard

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
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(BYTES)) db.createObjectStore(BYTES);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('geblokkeerd'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

const req2p = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

function tx(stores, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch { /* */ } reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('afgebroken'));
  }));
}

export function isQuotaError(e) {
  const n = e && e.name;
  return n === 'QuotaExceededError' || (n === 'UnknownError' && /quota|space|disk/i.test(String(e.message)));
}

/** Alleen geldige velden doorlaten (de database kan van een oudere of beschadigde versie zijn). */
function clean(r) {
  if (!r || typeof r.key !== 'string' || !r.key) return null;
  return {
    key: r.key,
    name: typeof r.name === 'string' ? r.name.slice(0, 255) : '',
    size: Number.isFinite(r.size) && r.size >= 0 ? r.size : 0,
    openedAt: Number.isFinite(r.openedAt) ? r.openedAt : 0,
    pages: Number.isInteger(r.pages) && r.pages > 0 ? r.pages : 0,
    locked: r.locked === true,
    thumb: r.thumb instanceof Blob && /^image\/(webp|jpeg|png)$/.test(r.thumb.type) ? r.thumb : null,
  };
}

const newestFirst = (a, b) => b.openedAt - a.openedAt;

/** Lijst, nieuwste eerst (max. MAX_RECENT). Zonder IndexedDB: lege lijst. */
export async function listRecent() {
  try {
    const all = await tx([META], 'readonly', (t) => req2p(t.objectStore(META).getAll()));
    return all.map(clean).filter(Boolean).sort(newestFirst).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export async function getRecent(key) {
  if (!key) return null;
  try {
    return clean(await tx([META], 'readonly', (t) => req2p(t.objectStore(META).get(key))));
  } catch {
    return null;
  }
}

/** De bewaarde kopie van de PDF (Blob) of null. */
export async function getBytes(key) {
  if (!key) return null;
  const b = await tx([BYTES], 'readonly', (t) => req2p(t.objectStore(BYTES).get(key)));
  return b instanceof Blob && b.size > 0 ? b : null;
}

async function write(meta, bytes) {
  await tx([META, BYTES], 'readwrite', async (t) => {
    const ms = t.objectStore(META);
    const bs = t.objectStore(BYTES);
    if (bytes) await req2p(bs.put(bytes, meta.key));
    await req2p(ms.put(meta));
    // Oudste laten afvallen (metagegevens + bytes in dezelfde transactie).
    const all = (await req2p(ms.getAll())).map(clean).filter(Boolean).sort(newestFirst);
    for (const r of all.slice(MAX_RECENT)) {
      await req2p(ms.delete(r.key));
      await req2p(bs.delete(r.key));
    }
  });
}

/**
 * Zet een document bovenaan. bytes = Blob met de originele PDF, of null om de bestaande kopie te houden.
 * Past het niet (QuotaExceeded), dan valt steeds het oudste andere document af en volgt een nieuwe poging.
 * Gooit een fout als het ook als enige document niet past.
 */
export async function putRecent(meta, bytes) {
  const rec = clean(meta);
  if (!rec) throw new Error('ongeldig');
  for (;;) {
    try {
      await write(rec, bytes);
      return;
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      const others = (await listAllRaw()).filter((r) => r.key !== rec.key).sort((a, b) => a.openedAt - b.openedAt);
      if (!others.length) throw e;
      await removeRecent(others[0].key);
    }
  }
}

async function listAllRaw() {
  const all = await tx([META], 'readonly', (t) => req2p(t.objectStore(META).getAll()));
  return all.map(clean).filter(Boolean);
}

export async function removeRecent(key) {
  if (!key) return;
  await tx([META, BYTES], 'readwrite', async (t) => {
    await req2p(t.objectStore(META).delete(key));
    await req2p(t.objectStore(BYTES).delete(key));
  });
}

export async function clearRecent() {
  try {
    await tx([META, BYTES], 'readwrite', async (t) => {
      await req2p(t.objectStore(META).clear());
      await req2p(t.objectStore(BYTES).clear());
    });
  } catch {
    // Laatste redmiddel: hele database weg.
    await new Promise((resolve) => {
      try {
        const r = indexedDB.deleteDatabase(DB_NAME);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      } catch { resolve(); }
    });
  }
}

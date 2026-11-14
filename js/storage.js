// fix-1
// fix-5: zoom vanaf 25% geldig (zie viewer.js).
// Voorkeuren in localStorage. Alleen fingerprint, pagina en zoom; nooit inhoud of paden.
// Alle toegang in try/catch (bijv. privémodus of uitgeschakelde opslag).

const KEY_ZOOM = 'pdfreader.zoom';
const KEY_DOCS = 'pdfreader.docs';
const KEY_PREFIX = 'pdfreader.';
const MAX_DOCS = 50;

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* opslag niet beschikbaar: stil negeren */
  }
}

/** Zoom is 'width', 'page', 'auto' of een getal (1 = 100%). */
export function isValidZoom(z) {
  return z === 'width' || z === 'page' || z === 'auto' ||
    (typeof z === 'number' && Number.isFinite(z) && z >= 0.25 && z <= 4);
}

export function getZoomPref() {
  const z = read(KEY_ZOOM);
  return isValidZoom(z) ? z : null;
}

export function setZoomPref(z) {
  if (isValidZoom(z)) write(KEY_ZOOM, z);
}

function getDocs() {
  const d = read(KEY_DOCS);
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}

export function getDocState(fp) {
  if (typeof fp !== 'string') return null;
  const s = getDocs()[fp];
  if (!s || typeof s !== 'object') return null;
  const page = Number.isInteger(s.p) && s.p > 0 ? s.p : 1;
  const zoom = isValidZoom(s.z) ? s.z : null;
  return { page, zoom };
}

export function setDocState(fp, page, zoom) {
  if (typeof fp !== 'string' || !fp) return;
  const docs = getDocs();
  docs[fp] = { p: page, z: isValidZoom(zoom) ? zoom : undefined, t: Date.now() };
  const keys = Object.keys(docs);
  if (keys.length > MAX_DOCS) {
    keys.sort((a, b) => (docs[a].t || 0) - (docs[b].t || 0));
    for (const k of keys.slice(0, keys.length - MAX_DOCS)) delete docs[k];
  }
  write(KEY_DOCS, docs);
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY_DOCS);
  } catch { /* negeren */ }
}

export function getFlag(name) {
  return read(KEY_PREFIX + name);
}

export function setFlag(name, value) {
  write(KEY_PREFIX + name, value);
}

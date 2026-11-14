// fix-2
// Module "annot-model": datamodel, geometrie, tekstopmaak en ongedaan-maken voor aantekeningen.
// Puur rekenwerk, geen DOM. Wordt gedeeld door het tekenscherm (annotations.js) en
// het wegschrijven naar PDF (annot-export.js), zodat beide exact hetzelfde tekenen.
//
// Coördinaten: PDF-punten (1/72 inch) in de WEERGAVERUIMTE van de pagina bij zoom 100%:
// oorsprong linksboven, y omlaag, inclusief paginarotatie (/Rotate) en CropBox.
// Zoom heeft er dus geen invloed op. Bij opslaan rekent annot-export.js dit om naar de
// gebruikersruimte van de PDF (oorsprong linksonder) via de pdf.js-viewport.

/** Vast kleurpalet (ui-fix2.md §3). */
export const PALETTE = [
  { name: 'Rood', hex: '#D32F2F' },
  { name: 'Blauw', hex: '#1565C0' },
  { name: 'Groen', hex: '#2E7D32' },
  { name: 'Geel', hex: '#FFD600' },
  { name: 'Zwart', hex: '#1C1E21' },
  { name: 'Oranje', hex: '#EF6C00' },
  { name: 'Paars', hex: '#7B1FA2' },
  { name: 'Wit', hex: '#FFFFFF' },
];
export const YELLOW = '#FFD600';
export const DEFAULT_COLOR = '#D32F2F';

export const WIDTHS = [
  { name: 'Dun', value: 1.5 },
  { name: 'Middel', value: 3 },
  { name: 'Dik', value: 6 },
];
export const DEFAULT_WIDTH = 3;

export const SIZES = [
  { name: 'Klein', value: 10 },
  { name: 'Middel', value: 14 },
  { name: 'Groot', value: 20 },
];
export const DEFAULT_SIZE = 14;

export const TYPES = ['pen', 'line', 'rect', 'oval', 'text'];
export const TYPE_NAMES = { pen: 'Pen', line: 'Lijn', rect: 'Rechthoek', oval: 'Ovaal', text: 'Tekst' };

/** Regelafstand en eerste basislijn (gelijk aan pdf.js FreeText, zodat alle routes overeenkomen). */
export const LINE_FACTOR = 1.35;
export const TEXT_PAD = 2; // pt extra breedte rond tekst
export const MARKER_OPACITY = 0.45;
export const MARKER_FACTOR = 3;
export const MIN_LINE = 3; // pt
export const MIN_SHAPE = 4; // pt
export const MAX_TEXT = 2000; // tekens

const HEX_RE = /^#[0-9A-F]{6}$/;

export function normHex(c) {
  const s = String(c || '').trim().toUpperCase();
  return HEX_RE.test(s) ? s : null;
}

export function colorName(hex) {
  const h = normHex(hex);
  const p = PALETTE.find((c) => c.hex === h);
  return p ? p.name.toLowerCase() : 'eigen kleur';
}

export function hexToRgb(hex) {
  const h = normHex(hex) || DEFAULT_COLOR;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Geel bij pen/lijn = markeerstift: halfdoorzichtig en 3× zo dik. */
export function isMarker(item) {
  return (item.type === 'pen' || item.type === 'line') && normHex(item.color) === YELLOW;
}

/** Effectieve tekenstijl. */
export function strokeStyle(item) {
  const marker = isMarker(item);
  return {
    color: normHex(item.color) || DEFAULT_COLOR,
    width: (Number(item.width) || DEFAULT_WIDTH) * (marker ? MARKER_FACTOR : 1),
    opacity: marker ? MARKER_OPACITY : 1,
  };
}

// ---------- Tekst: Helvetica-breedtes (AFM, per 1000 eenheden) ----------
// Gelijk aan de standaard-PDF-letter Helvetica (en metrisch gelijk aan Arial / Liberation Sans),
// zodat afbreken en kadergrootte in de app en in de PDF identiek zijn.
const ASCII_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722,
  778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const LATIN1_W = [278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556,
  537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278,
  278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500,
  556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500];
const EXTRA_W = new Map([[338, 1000], [339, 944], [352, 667], [353, 500], [376, 500], [381, 611], [382, 500], [402, 556],
  [710, 333], [732, 333], [8211, 556], [8212, 1000], [8216, 222], [8217, 222], [8218, 222], [8220, 333], [8221, 333],
  [8222, 333], [8224, 556], [8225, 556], [8226, 350], [8230, 1000], [8240, 1000], [8249, 333], [8250, 333], [8364, 556],
  [8482, 1000]]);
const FALLBACK_W = 600;

function charWidth(cp) {
  if (cp >= 32 && cp < 127) return ASCII_W[cp - 32];
  if (cp >= 160 && cp <= 255) return LATIN1_W[cp - 160];
  return EXTRA_W.get(cp) || FALLBACK_W;
}

/** Past de tekst volledig in WinAnsi (standaardletter Helvetica)? */
export function isWinAnsi(str) {
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp === 10) continue;
    if (!((cp >= 32 && cp < 127) || (cp >= 160 && cp <= 255) || EXTRA_W.has(cp))) return false;
  }
  return true;
}

export function textWidth(str, size) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch.codePointAt(0));
  return (w * size) / 1000;
}

/** Breekt tekst af op maxW (pt). Harde regeleinden blijven behouden. */
export function wrapText(text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    const words = para.split(/( +)/);
    let line = '';
    for (const part of words) {
      if (!part) continue;
      const trial = line + part;
      if (!line || textWidth(trial.trimEnd(), size) <= maxW) { line = trial; continue; }
      out.push(line.trimEnd());
      line = part.trimStart();
      // Heel lang woord: per teken afbreken.
      while (line && textWidth(line, size) > maxW) {
        let i = 1;
        while (i < line.length && textWidth(line.slice(0, i + 1), size) <= maxW) i++;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Opmaak van een tekstaantekening: regels en kader (pt). */
export function textLayout(item) {
  const size = item.fontSize || DEFAULT_SIZE;
  const maxW = Math.max(size, item.maxW || 10000);
  const lines = wrapText(item.text || '', size, maxW);
  let w = 0;
  for (const l of lines) w = Math.max(w, textWidth(l, size));
  return { lines, size, w: w + TEXT_PAD, h: lines.length * size * LINE_FACTOR, lineH: size * LINE_FACTOR };
}

// ---------- Geometrie ----------

export function bbox(item) {
  switch (item.type) {
    case 'pen': {
      const p = item.points;
      let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        x1 = Math.min(x1, p[i]); x2 = Math.max(x2, p[i]);
        y1 = Math.min(y1, p[i + 1]); y2 = Math.max(y2, p[i + 1]);
      }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    case 'line':
      return {
        x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2),
        w: Math.abs(item.x2 - item.x1), h: Math.abs(item.y2 - item.y1),
      };
    case 'text': {
      const l = textLayout(item);
      return { x: item.x, y: item.y, w: l.w, h: l.h };
    }
    default:
      return { x: item.x, y: item.y, w: item.w, h: item.h };
  }
}

/** Kader inclusief lijndikte (voor /Rect en BBox). */
export function outerBox(item) {
  const b = bbox(item);
  if (item.type === 'text') return b;
  const half = strokeStyle(item).width / 2 + 1;
  return { x: b.x - half, y: b.y - half, w: b.w + 2 * half, h: b.h + 2 * half };
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Afstand van punt tot de getekende vorm (0 = erop/erin). */
export function distance(item, x, y) {
  const half = item.type === 'text' ? 0 : strokeStyle(item).width / 2;
  switch (item.type) {
    case 'pen': {
      const p = item.points;
      if (p.length === 2) return Math.max(0, Math.hypot(x - p[0], y - p[1]) - half);
      let d = Infinity;
      for (let i = 0; i + 3 < p.length; i += 2) d = Math.min(d, distToSeg(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]));
      return Math.max(0, d - half);
    }
    case 'line':
      return Math.max(0, distToSeg(x, y, item.x1, item.y1, item.x2, item.y2) - half);
    case 'rect': {
      const { x: rx, y: ry, w, h } = item;
      const inside = x >= rx && x <= rx + w && y >= ry && y <= ry + h;
      const edge = Math.min(
        distToSeg(x, y, rx, ry, rx + w, ry), distToSeg(x, y, rx + w, ry, rx + w, ry + h),
        distToSeg(x, y, rx + w, ry + h, rx, ry + h), distToSeg(x, y, rx, ry + h, rx, ry),
      );
      // Kleine vormen: binnenin telt ook.
      if (inside && (w < 24 || h < 24)) return 0;
      return Math.max(0, edge - half);
    }
    case 'oval': {
      const rx = item.w / 2;
      const ry = item.h / 2;
      const cx = item.x + rx;
      const cy = item.y + ry;
      if (rx < 0.5 || ry < 0.5) return Math.hypot(x - cx, y - cy);
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r = Math.hypot(nx, ny);
      if (r < 1 && (item.w < 24 || item.h < 24)) return 0;
      // Benadering van de afstand tot de ellipsrand.
      const d = Math.abs(r - 1) * Math.min(rx, ry);
      return Math.max(0, d - half);
    }
    case 'text': {
      const b = bbox(item);
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      return Math.hypot(dx, dy);
    }
    default:
      return Infinity;
  }
}

export function translate(item, dx, dy) {
  const n = { ...item };
  switch (item.type) {
    case 'pen': n.points = item.points.map((v, i) => (i % 2 ? v + dy : v + dx)); break;
    case 'line': n.x1 += dx; n.x2 += dx; n.y1 += dy; n.y2 += dy; break;
    default: n.x += dx; n.y += dy;
  }
  return n;
}

/** Beperkt een verplaatsing zodat het item binnen de pagina blijft. */
export function clampDelta(item, dx, dy, pw, ph) {
  const b = bbox(item);
  const cx = Math.min(Math.max(dx, -b.x), pw - (b.x + b.w));
  const cy = Math.min(Math.max(dy, -b.y), ph - (b.y + b.h));
  return [b.w > pw ? dx : cx, b.h > ph ? dy : cy];
}

export const clampPt = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Formaat wijzigen met een greep.
 * rect/oval: nw n ne e se s sw w; line: p1 p2. Geeft een nieuw item (genormaliseerd).
 */
export function resize(item, handle, x, y, { keepRatio = false } = {}) {
  if (item.type === 'line') {
    const n = { ...item };
    if (handle === 'p1') { n.x1 = x; n.y1 = y; } else { n.x2 = x; n.y2 = y; }
    if (keepRatio) {
      const [ax, ay] = handle === 'p1' ? [n.x2, n.y2] : [n.x1, n.y1];
      const [sx, sy] = snap45(ax, ay, x, y);
      if (handle === 'p1') { n.x1 = sx; n.y1 = sy; } else { n.x2 = sx; n.y2 = sy; }
    }
    return n;
  }
  let x1 = item.x; let y1 = item.y; let x2 = item.x + item.w; let y2 = item.y + item.h;
  if (handle.includes('w')) x1 = x;
  if (handle.includes('e')) x2 = x;
  if (handle.includes('n')) y1 = y;
  if (handle.includes('s')) y2 = y;
  if (keepRatio && handle.length === 2) {
    const s = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    if (handle.includes('w')) x1 = x2 - s * Math.sign(x2 - x1 || 1); else x2 = x1 + s * Math.sign(x2 - x1 || 1);
    if (handle.includes('n')) y1 = y2 - s * Math.sign(y2 - y1 || 1); else y2 = y1 + s * Math.sign(y2 - y1 || 1);
  }
  return {
    ...item,
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.max(MIN_SHAPE, Math.abs(x2 - x1)), h: Math.max(MIN_SHAPE, Math.abs(y2 - y1)),
  };
}

/** Rechte lijn vastzetten op 0/45/90 graden. */
export function snap45(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [x1 + len * Math.cos(ang), y1 + len * Math.sin(ang)];
}

/** Kader uit twee hoekpunten; met Shift vierkant/cirkel. */
export function boxFrom(x1, y1, x2, y2, square = false) {
  let w = x2 - x1;
  let h = y2 - y1;
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = s * (Math.sign(w) || 1);
    h = s * (Math.sign(h) || 1);
  }
  return { x: Math.min(x1, x1 + w), y: Math.min(y1, y1 + h), w: Math.abs(w), h: Math.abs(h) };
}

// ---------- Penstreken: vereenvoudigen en vloeiend tekenen ----------

/** Ramer–Douglas–Peucker op een platte lijst [x,y,x,y,...]. */
export function simplify(points, tol = 0.5) {
  const n = points.length / 2;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(points[2 * i], points[2 * i + 1], points[2 * a], points[2 * a + 1], points[2 * b], points[2 * b + 1]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[2 * i], points[2 * i + 1]);
  return out;
}

/**
 * Segmenten voor een vloeiende lijn door de punten (Catmull-Rom → kubische Bézier).
 * Resultaat: { start:[x,y], curves:[[c1x,c1y,c2x,c2y,x,y], ...] }.
 */
export function smoothCurves(p) {
  const n = p.length / 2;
  const start = [p[0], p[1]];
  const curves = [];
  if (n === 1) return { start, curves: [[p[0], p[1], p[0], p[1], p[0] + 0.01, p[1]]] };
  if (n === 2) return { start, curves: [[p[0], p[1], p[2], p[3], p[2], p[3]]] };
  const pt = (i) => [p[2 * Math.max(0, Math.min(n - 1, i))], p[2 * Math.max(0, Math.min(n - 1, i)) + 1]];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pt(i - 1);
    const [x1, y1] = pt(i);
    const [x2, y2] = pt(i + 1);
    const [x3, y3] = pt(i + 2);
    curves.push([
      x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6,
      x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6,
      x2, y2,
    ]);
  }
  return { start, curves };
}

const KAPPA = 0.5522847498;

/** Ellips als 4 Bézier-curves. */
export function ellipseCurves(x, y, w, h) {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return {
    start: [cx + rx, cy],
    curves: [
      [cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry],
      [cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
      [cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry],
      [cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ],
  };
}

/**
 * Vormen als lijst van subpaden, elk { start, segs }, waarbij een seg
 * [x,y] (rechte lijn) of [c1x,c1y,c2x,c2y,x,y] (Bézier) is. Voor tekst: null.
 */
export function shapePaths(item) {
  switch (item.type) {
    case 'pen': {
      const { start, curves } = smoothCurves(item.points);
      return [{ start, segs: curves, closed: false }];
    }
    case 'line':
      return [{ start: [item.x1, item.y1], segs: [[item.x2, item.y2]], closed: false }];
    case 'rect': {
      const { x, y, w, h } = item;
      return [{ start: [x, y], segs: [[x + w, y], [x + w, y + h], [x, y + h], [x, y]], closed: true }];
    }
    case 'oval': {
      const { start, curves } = ellipseCurves(item.x, item.y, item.w, item.h);
      return [{ start, segs: curves, closed: true }];
    }
    default:
      return null;
  }
}

const f2 = (v) => (Math.round(v * 100) / 100).toString();

/** SVG-padtekst (weergaveruimte). */
export function svgPath(item) {
  const paths = shapePaths(item);
  if (!paths) return '';
  let d = '';
  for (const sp of paths) {
    d += `M${f2(sp.start[0])} ${f2(sp.start[1])}`;
    for (const s of sp.segs) d += s.length === 2 ? `L${f2(s[0])} ${f2(s[1])}` : `C${s.map(f2).join(' ')}`;
    if (sp.closed) d += 'Z';
  }
  return d;
}

// ---------- Validatie (gegevens uit IndexedDB) ----------

const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;

/** Controleert en normaliseert een item; geeft null bij ongeldige gegevens. */
export function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.includes(raw.type)) return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : null;
  const page = Number.isInteger(raw.page) && raw.page > 0 ? raw.page : null;
  const color = normHex(raw.color);
  if (!id || !page || !color) return null;
  const base = { id, page, type: raw.type, color, created: finite(raw.created) ? raw.created : Date.now() };
  switch (raw.type) {
    case 'pen': {
      if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length % 2 || raw.points.length > 20000) return null;
      if (!raw.points.every(finite)) return null;
      return { ...base, width: finite(raw.width) && raw.width > 0 && raw.width <= 50 ? raw.width : DEFAULT_WIDTH, points: raw.points.slice() };
    }
    case 'line':
      if (![raw.x1, raw.y1, raw.x2, raw.y2].every(finite)) return null;
      return { ...base, width: finite(raw.width) && raw.width > 0 && raw.width <= 50 ? raw.width : DEFAULT_WIDTH, x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2 };
    case 'rect':
    case 'oval':
      if (![raw.x, raw.y, raw.w, raw.h].every(finite) || raw.w < 0 || raw.h < 0) return null;
      return { ...base, width: finite(raw.width) && raw.width > 0 && raw.width <= 50 ? raw.width : DEFAULT_WIDTH, x: raw.x, y: raw.y, w: raw.w, h: raw.h };
    case 'text': {
      if (typeof raw.text !== 'string' || !raw.text.trim() || ![raw.x, raw.y].every(finite)) return null;
      const fontSize = finite(raw.fontSize) && raw.fontSize >= 4 && raw.fontSize <= 96 ? raw.fontSize : DEFAULT_SIZE;
      return { ...base, x: raw.x, y: raw.y, text: raw.text.slice(0, MAX_TEXT), fontSize, maxW: finite(raw.maxW) && raw.maxW > 0 ? raw.maxW : 10000 };
    }
    default:
      return null;
  }
}

export function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Toegankelijke naam, bijv. "Ovaal, rood, pagina 3" of 'Tekst: "Navragen", pagina 3'. */
export function describe(item) {
  if (item.type === 'text') {
    const t = item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text;
    return `Tekst: "${t.replace(/\n/g, ' ')}", pagina ${item.page}`;
  }
  return `${TYPE_NAMES[item.type]}, ${colorName(item.color)}, pagina ${item.page}`;
}

// ---------- Ongedaan maken / opnieuw ----------

/**
 * Commandostack met momentopnamen per item: elk commando is een lijst [id, voor, na]
 * (null = bestaat niet). Ongedaan maken zet "voor" terug, opnieuw zet "na".
 */
export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(label, changes) {
    if (!changes.length) return;
    this.undoStack.push({ label, changes });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** @returns {{label:string, apply:Array<[string, object|null]>}|null} */
  undo() {
    const c = this.undoStack.pop();
    if (!c) return null;
    this.redoStack.push(c);
    return { label: c.label, apply: c.changes.map(([id, before]) => [id, before]) };
  }

  redo() {
    const c = this.redoStack.pop();
    if (!c) return null;
    this.undoStack.push(c);
    return { label: c.label, apply: c.changes.map(([id, , after]) => [id, after]) };
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

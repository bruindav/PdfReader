// fix-2
// Module "annot-export": PDF opslaan MET aantekeningen.
//
// Twee routes, beide met echte PDF-annotaties inclusief eigen weergave (/AP):
//  1. pdf-lib (gewone PDF's): /Ink, /Line, /Square, /Circle en /FreeText met /NM "pdfreader-<id>".
//     Optioneel "vastzetten": dezelfde weergave wordt in de pagina-inhoud getekend.
//     pdf-lib (en voor niet-WinAnsi-tekst fontkit + Noto Sans) wordt pas bij het eerste gebruik geladen.
//  2. pdf.js saveDocument (beveiligde/versleutelde en digitaal ondertekende PDF's):
//     incrementele update waarbij pdf.js de nieuwe objecten met dezelfde sleutel versleutelt.
//     De beveiliging blijft dus intact, er ontstaat geen onbeveiligde kopie en een bestaande
//     handtekening blijft bij de ondertekende revisie horen. Vormen worden /Ink, tekst /FreeText.
// Na het maken wordt het resultaat altijd opnieuw met pdf.js geopend ter controle.
import { pdfjsLib } from './loader.js';
import {
  shapePaths, strokeStyle, textLayout, outerBox, hexToRgb, isWinAnsi,
} from './annot-model.js';

const VENDOR = new URL('../vendor/', import.meta.url);
let pdfLibPromise = null;
let fontkitPromise = null;
let notoPromise = null;

/** Laadt pdf-lib (lazy). Kan vooraf worden aangeroepen om het opslaan te versnellen. */
export function preloadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import(new URL('pdf-lib/pdf-lib.esm.min.js', VENDOR).href);
    pdfLibPromise.catch(() => { pdfLibPromise = null; });
  }
  return pdfLibPromise;
}

async function loadFontkit() {
  if (!fontkitPromise) {
    // UMD-bundel: zet self.fontkit.
    fontkitPromise = import(new URL('pdf-lib/fontkit.umd.min.js', VENDOR).href).then(() => self.fontkit);
    fontkitPromise.catch(() => { fontkitPromise = null; });
  }
  return fontkitPromise;
}

async function loadNoto() {
  if (!notoPromise) {
    notoPromise = fetch(new URL('fonts/NotoSans-Regular.ttf', VENDOR).href).then((r) => {
      if (!r.ok) throw new Error(`font ${r.status}`);
      return r.arrayBuffer();
    });
    notoPromise.catch(() => { notoPromise = null; });
  }
  return notoPromise;
}

// ---------- Matrixrekenen ----------

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v) => {
  const s = r3(v).toString();
  return s === '-0' ? '0' : s;
};

/**
 * Geometrie per pagina: van weergaveruimte (pt, y omlaag) naar PDF-gebruikersruimte.
 * F-ruimte = weergaveruimte met y omhoog (Y' = H - Y), waarin we de /AP tekenen.
 */
async function pageGeometry(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const inv = invert(vp.transform);
  const H = vp.height;
  // user = inv · (X, H − Y')
  const formMatrix = [inv[0], inv[1], -inv[2], -inv[3], inv[2] * H + inv[4], inv[3] * H + inv[5]];
  return {
    H,
    rotation: ((vp.rotation % 360) + 360) % 360,
    toUser: (x, y) => apply(inv, x, y),
    formMatrix,
  };
}

/** Kader (weergaveruimte) → rechthoek in gebruikersruimte [x1 y1 x2 y2]. */
function userRect(geo, b) {
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => geo.toUser(x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r3);
}

const pdfColor = (hex) => hexToRgb(hex).map((v) => num(v / 255)).join(' ');

/** Paden als PDF-operatoren in F-ruimte. */
function pathOps(item, H) {
  const out = [];
  for (const sp of shapePaths(item)) {
    out.push(`${num(sp.start[0])} ${num(H - sp.start[1])} m`);
    for (const s of sp.segs) {
      if (s.length === 2) out.push(`${num(s[0])} ${num(H - s[1])} l`);
      else out.push(`${num(s[0])} ${num(H - s[1])} ${num(s[2])} ${num(H - s[3])} ${num(s[4])} ${num(H - s[5])} c`);
    }
    if (sp.closed) out.push('h');
  }
  return out;
}

const pdfDate = (t = Date.now()) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

function randomHex(n = 16) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Route 1: pdf-lib ----------

async function exportWithPdfLib(pdf, bytes, items, { flatten }) {
  const lib = await preloadPdfLib();
  const { PDFDocument, PDFString, PDFHexString, PDFArray, StandardFonts } = lib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();

  let helv = null;
  let noto = null;
  const needNoto = items.some((it) => it.type === 'text' && !isWinAnsi(it.text));
  if (items.some((it) => it.type === 'text')) helv = await doc.embedFont(StandardFonts.Helvetica);
  if (needNoto) {
    try {
      const [fk, fontBytes] = await Promise.all([loadFontkit(), loadNoto()]);
      doc.registerFontkit(fk);
      noto = await doc.embedFont(fontBytes, { subset: true });
    } catch {
      noto = null; // terugval: Helvetica, niet-ondersteunde tekens worden '?'
    }
  }

  const geoCache = new Map();
  const flatByPage = new Map();
  const now = pdfDate();

  for (const item of items) {
    const page = pages[item.page - 1];
    if (!page) continue;
    if (!geoCache.has(item.page)) geoCache.set(item.page, await pageGeometry(pdf, item.page));
    const geo = geoCache.get(item.page);
    const H = geo.H;
    const color = hexToRgb(item.color).map((v) => r3(v / 255));
    const resources = {};
    let ops;
    let box;

    if (item.type === 'text') {
      const lay = textLayout(item);
      const useNoto = !isWinAnsi(item.text) && noto;
      const font = useNoto ? noto : helv;
      let w = lay.w;
      if (useNoto) for (const l of lay.lines) w = Math.max(w, font.widthOfTextAtSize(l, lay.size) + 2);
      box = { x: item.x, y: item.y, w, h: lay.h };
      resources.Font = { F0: font.ref };
      ops = ['BT', `${pdfColor(item.color)} rg`, `/F0 ${num(lay.size)} Tf`];
      lay.lines.forEach((line, i) => {
        if (!line) return;
        let safe = line;
        if (!useNoto && !isWinAnsi(line)) safe = Array.from(line, (ch) => (isWinAnsi(ch) ? ch : '?')).join('');
        const baseY = H - (item.y + lay.size + i * lay.lineH);
        ops.push(`1 0 0 1 ${num(item.x + 1)} ${num(baseY)} Tm`, `${font.encodeText(safe).toString()} Tj`);
      });
      ops.push('ET');
    } else {
      const st = strokeStyle(item);
      box = outerBox(item);
      ops = [];
      if (st.opacity < 1) {
        resources.ExtGState = { GS0: { Type: 'ExtGState', CA: st.opacity, ca: st.opacity } };
        ops.push('/GS0 gs');
      }
      ops.push(`${num(st.width)} w 1 J 1 j`, `${pdfColor(item.color)} RG`, ...pathOps(item, H), 'S');
    }

    const bboxF = [box.x, H - (box.y + box.h), box.x + box.w, H - box.y].map(r3);
    const ap = ctx.flateStream(`q\n${ops.join('\n')}\nQ\n`, {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bboxF,
      Matrix: geo.formMatrix.map((v) => r3(v)), Resources: resources,
    });
    const apRef = ctx.register(ap);

    if (flatten) {
      if (!flatByPage.has(item.page)) flatByPage.set(item.page, []);
      flatByPage.get(item.page).push(apRef);
      continue;
    }

    const rect = userRect(geo, box);
    const dict = {
      Type: 'Annot', Rect: rect, F: 4, C: color,
      NM: PDFString.of(`pdfreader-${item.id}`), M: PDFString.of(now), CreationDate: PDFString.of(now),
      AP: { N: apRef }, P: page.ref,
    };
    if (item.type === 'text') {
      Object.assign(dict, {
        Subtype: 'FreeText',
        Contents: PDFHexString.fromText(item.text),
        DA: PDFString.of(`/Helv ${num(item.fontSize)} Tf ${pdfColor(item.color)} rg`),
        Border: [0, 0, 0], BS: { W: 0 }, Q: 0,
      });
      if (geo.rotation) dict.Rotate = geo.rotation;
    } else {
      const st = strokeStyle(item);
      dict.BS = { W: r3(st.width), S: 'S' };
      if (st.opacity < 1) dict.CA = st.opacity;
      if (item.type === 'pen') {
        dict.Subtype = 'Ink';
        const pts = [];
        for (let i = 0; i < item.points.length; i += 2) pts.push(...geo.toUser(item.points[i], item.points[i + 1]).map(r3));
        dict.InkList = [pts];
      } else if (item.type === 'line') {
        dict.Subtype = 'Line';
        dict.L = [...geo.toUser(item.x1, item.y1), ...geo.toUser(item.x2, item.y2)].map(r3);
      } else {
        dict.Subtype = item.type === 'rect' ? 'Square' : 'Circle';
      }
    }
    const ref = ctx.register(ctx.obj(dict));
    page.node.addAnnot(ref);
  }

  // Vastzetten: de weergave-XObjects in de pagina-inhoud tekenen (na de bestaande inhoud).
  for (const [num1, refs] of flatByPage) {
    const page = pages[num1 - 1];
    const names = refs.map((r) => page.node.newXObject('PdfR', r));
    const start = ctx.register(ctx.stream('q\n'));
    const end = ctx.register(ctx.stream(`Q\n${names.map((n) => `q ${n.toString()} Do Q`).join('\n')}\n`));
    page.node.wrapContentStreams(start, end);
  }

  // Nieuwe tweede /ID, zodat de opgeslagen PDF een eigen vingerafdruk krijgt.
  const oldId = ctx.trailerInfo.ID;
  let id0 = null;
  try {
    const arr = oldId && ctx.lookup(oldId, PDFArray);
    id0 = arr && arr.size() > 0 ? arr.get(0) : null;
  } catch { id0 = null; }
  ctx.trailerInfo.ID = ctx.obj([id0 || PDFHexString.of(randomHex()), PDFHexString.of(randomHex())]);

  return doc.save();
}

// ---------- Route 2: pdf.js saveDocument (versleuteld / ondertekend) ----------

const PREFIX = 'pdfjs_internal_editor_pdfreader_';

async function exportWithPdfJs(pdf, items) {
  const storage = pdf.annotationStorage;
  const { AnnotationEditorType } = pdfjsLib;
  const keys = [];
  try {
    const geoCache = new Map();
    let i = 0;
    for (const item of items) {
      if (item.page > pdf.numPages) continue;
      if (!geoCache.has(item.page)) geoCache.set(item.page, await pageGeometry(pdf, item.page));
      const geo = geoCache.get(item.page);
      const key = `${PREFIX}${i++}`;
      const color = hexToRgb(item.color);
      if (item.type === 'text') {
        const lay = textLayout(item);
        storage.setValue(key, {
          annotationType: AnnotationEditorType.FREETEXT,
          pageIndex: item.page - 1,
          color,
          fontSize: lay.size,
          value: lay.lines.join('\n'),
          rect: userRect(geo, { x: item.x + 1, y: item.y, w: lay.w, h: lay.h + 0.5 }),
          rotation: geo.rotation,
        });
      } else {
        const st = strokeStyle(item);
        const lines = [];
        const points = [];
        for (const sp of shapePaths(item)) {
          const arr = [NaN, NaN, NaN, NaN, ...geo.toUser(sp.start[0], sp.start[1])];
          const pts = [...geo.toUser(sp.start[0], sp.start[1])];
          for (const s of sp.segs) {
            if (s.length === 2) {
              const p = geo.toUser(s[0], s[1]);
              arr.push(NaN, NaN, NaN, NaN, ...p);
              pts.push(...p);
            } else {
              const p = geo.toUser(s[4], s[5]);
              arr.push(...geo.toUser(s[0], s[1]), ...geo.toUser(s[2], s[3]), ...p);
              pts.push(...p);
            }
          }
          lines.push(new Float32Array(arr));
          points.push(pts.map(r3));
        }
        storage.setValue(key, {
          annotationType: AnnotationEditorType.INK,
          pageIndex: item.page - 1,
          color,
          thickness: st.width,
          opacity: st.opacity,
          rect: userRect(geo, outerBox(item)),
          rotation: 0,
          paths: { lines, points },
        });
      }
      keys.push(key);
    }
    return await pdf.saveDocument();
  } finally {
    for (const k of keys) {
      try { storage.remove(k); } catch { /* */ }
    }
  }
}

// ---------- Controle ----------

async function verify(bytes, password, expectedPages) {
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head !== '%PDF-') throw new Error('geen PDF-kop');
  const task = pdfjsLib.getDocument({ data: bytes.slice(), password: password || undefined, isEvalSupported: false, stopAtErrors: true });
  try {
    const d = await task.promise;
    if (d.numPages !== expectedPages) throw new Error('aantal pagina\'s wijkt af');
    await d.getPage(1);
    return { fingerprints: d.fingerprints };
  } finally {
    task.destroy();
  }
}

/**
 * Kiest de route voor dit document.
 * @returns {Promise<{route:'pdflib'|'pdfjs', encrypted:boolean, signed:boolean}>}
 */
export async function analyse(pdf) {
  let encrypted = false;
  let signed = false;
  try { encrypted = (await pdf.getPermissions()) !== null; } catch { encrypted = false; }
  try {
    const fields = await pdf.getFieldObjects();
    if (fields) signed = Object.values(fields).some((arr) => Array.isArray(arr) && arr.some((f) => f && f.type === 'signature'));
  } catch { signed = false; }
  return { route: encrypted || signed ? 'pdfjs' : 'pdflib', encrypted, signed };
}

/**
 * Maakt de PDF met aantekeningen.
 * @param {object} o
 * @param {*} o.pdf        pdf.js-document (geopend in de viewer)
 * @param {Blob} o.blob    originele bytes
 * @param {Array} o.items  aantekeningen
 * @param {boolean} o.flatten  vastzetten (alleen pdf-lib-route)
 * @param {string|null} o.password  alleen in het geheugen, voor de controle
 * @returns {Promise<{blob:Blob, route:string}>}
 */
export async function exportAnnotated({ pdf, blob, items, flatten = false, password = null }) {
  const info = await analyse(pdf);
  let bytes;
  let route = info.route;
  if (route === 'pdflib') {
    try {
      const orig = new Uint8Array(await blob.arrayBuffer());
      bytes = await exportWithPdfLib(pdf, orig, items, { flatten });
      await verify(bytes, password, pdf.numPages);
    } catch (e) {
      // pdf-lib kan sommige (afwijkende) PDF's niet lezen: val terug op de pdf.js-route.
      if (flatten) throw e;
      route = 'pdfjs';
      bytes = null;
    }
  }
  if (!bytes) {
    bytes = await exportWithPdfJs(pdf, items);
    await verify(bytes, password, pdf.numPages);
  }
  return { blob: new Blob([bytes], { type: 'application/pdf' }), route, ...info };
}


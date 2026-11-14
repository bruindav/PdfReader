// fix-3
// Module "android-bridge": koppeling met de Android-app (WebView-schil, map android/).
// Alleen actief als de Android-app het object `PdfReaderAndroid` heeft geïnjecteerd. De app doet dat
// via WebViewCompat.addWebMessageListener, uitsluitend voor de origin https://bruindav.github.io.
// In een gewone browser bestaat dat object niet en doet deze module niets.
//
// Protocol (berichten zijn JSON-strings; bytes gaan als ArrayBuffer als beide kanten dat
// ondersteunen, anders als base64-tekst in stukken):
//   web → app:  {type:'ready', v:1}
//               {type:'save-begin', id, name, size, action:'save'|'share'}
//               ArrayBuffer | {type:'save-chunk', id, b64}   (herhaald)
//               {type:'save-end', id}
//   app → web:  {type:'hello', v:1, binary:boolean}
//               {type:'file-begin', id, name, size}
//               ArrayBuffer | {type:'file-chunk', id, b64}   (herhaald)
//               {type:'file-end', id} | {type:'file-error', id?, code}
//               {type:'save-result', id, status:'saved'|'shared'|'cancelled'|'error'|'too-big'}

const BRIDGE_NAME = 'PdfReaderAndroid';
const CHUNK = 512 * 1024; // bytes per bericht
export const MAX_BYTES = 200 * 1024 * 1024;

const bridge = () => {
  const b = globalThis[BRIDGE_NAME];
  return b && typeof b.postMessage === 'function' ? b : null;
};

/** True als de pagina in de Android-app draait. */
export const isAndroidApp = () => !!bridge();

let binary = false;
let started = false;
let handlers = { onFile: null, onError: null };
let incoming = null; // { id, name, size, parts: [], received }
let nextSaveId = 1;
const pendingSaves = new Map(); // id -> {resolve, reject}
let saveChain = Promise.resolve();

const send = (obj) => bridge().postMessage(JSON.stringify(obj));

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function addIncoming(bytes) {
  if (!incoming) return;
  incoming.received += bytes.byteLength;
  if (incoming.received > MAX_BYTES) {
    incoming = null;
    if (handlers.onError) handlers.onError('too-big');
    return;
  }
  incoming.parts.push(bytes);
}

function onMessage(event) {
  const data = event && event.data;
  if (data instanceof ArrayBuffer) { addIncoming(new Uint8Array(data)); return; }
  if (typeof data !== 'string') return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'hello':
      binary = msg.binary === true;
      break;
    case 'file-begin':
      incoming = { id: msg.id, name: String(msg.name || ''), size: Number(msg.size) || 0, parts: [], received: 0 };
      break;
    case 'file-chunk':
      if (incoming && msg.id === incoming.id && typeof msg.b64 === 'string') {
        try { addIncoming(b64ToBytes(msg.b64)); } catch { incoming = null; if (handlers.onError) handlers.onError('unknown'); }
      }
      break;
    case 'file-end': {
      if (!incoming || msg.id !== incoming.id) break;
      const { name, parts } = incoming;
      incoming = null;
      const file = new File(parts, name || 'document.pdf', { type: 'application/pdf' });
      if (handlers.onFile) handlers.onFile(file);
      break;
    }
    case 'file-error':
      incoming = null;
      if (handlers.onError) handlers.onError(['too-big', 'missing', 'not-pdf'].includes(msg.code) ? msg.code : 'unknown');
      break;
    case 'save-result': {
      const p = pendingSaves.get(msg.id);
      if (!p) break;
      pendingSaves.delete(msg.id);
      if (msg.status === 'saved' || msg.status === 'shared' || msg.status === 'cancelled') p.resolve(msg.status);
      else p.reject(new Error(`android-save-${msg.status || 'error'}`));
      break;
    }
    default:
      break;
  }
}

/**
 * Start de brug: luistert naar berichten van de app en meldt "ready".
 * De app houdt een bestand dat bij een koude start binnenkwam vast tot dit bericht er is.
 * @param {{onFile:(file:File)=>void, onError:(code:string)=>void}} h
 */
export function initAndroidBridge(h) {
  const b = bridge();
  if (!b || started) return false;
  started = true;
  handlers = { onFile: h.onFile || null, onError: h.onError || null };
  b.onmessage = onMessage;
  send({ type: 'ready', v: 1 });
  return true;
}

async function transfer(blobOrPromise, fileName, action) {
  const raw = await blobOrPromise; // kan ExportError gooien (PDF met aantekeningen)
  const blob = raw instanceof Blob ? raw : new Blob([raw], { type: 'application/pdf' });
  if (blob.size > MAX_BYTES) throw new Error('android-save-too-big');
  const id = nextSaveId++;
  const result = new Promise((resolve, reject) => pendingSaves.set(id, { resolve, reject }));
  send({ type: 'save-begin', id, name: fileName, size: blob.size, action });
  for (let off = 0; off < blob.size; off += CHUNK) {
    const buf = await blob.slice(off, off + CHUNK).arrayBuffer();
    if (binary) bridge().postMessage(buf);
    else send({ type: 'save-chunk', id, b64: bytesToB64(new Uint8Array(buf)) });
  }
  send({ type: 'save-end', id });
  return result;
}

/**
 * Laat de Android-app de PDF opslaan (mapkiezer) of delen.
 * @param {Blob|Promise<Blob>} blobOrPromise
 * @param {string} fileName
 * @param {'save'|'share'} action
 * @returns {Promise<'saved'|'shared'|'cancelled'>}
 */
export function androidSave(blobOrPromise, fileName, action = 'save') {
  if (!bridge()) return Promise.reject(new Error('android-bridge-missing'));
  // Overdrachten na elkaar, zodat stukken van twee bestanden niet door elkaar lopen.
  const run = saveChain.then(() => transfer(blobOrPromise, fileName, action));
  saveChain = run.catch(() => {});
  return run;
}

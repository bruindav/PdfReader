// fix-1
// Module "loader": PDF-validatie en openen met pdf.js (lokaal meegeleverd, geen CDN).
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;

export { pdfjsLib };

export class LoadError extends Error {
  /** @param {'not-pdf'|'corrupt'|'too-big'|'unknown'|'cancelled'|'missing'} code */
  constructor(code, cause) {
    super(code);
    this.name = 'LoadError';
    this.code = code;
    this.cause = cause;
  }
}

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Controleert of de magic bytes "%PDF-" in de eerste 1024 bytes staan. */
export async function hasPdfMagic(blob) {
  const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  outer: for (let i = 0; i <= head.length - MAGIC.length; i++) {
    for (let j = 0; j < MAGIC.length; j++) {
      if (head[i + j] !== MAGIC[j]) continue outer;
    }
    return true;
  }
  return false;
}

function isOutOfMemory(e) {
  return e instanceof RangeError || /out of memory|allocation failed|array buffer allocation/i.test(String(e && e.message));
}

/**
 * Opent een PDF.
 * De originele Blob blijft onaangeroerd; pdf.js krijgt een eigen kopie van de bytes
 * (die wordt naar de worker overgedragen), zodat opslaan altijd de originele bytes oplevert.
 * @param {Blob} blob
 * @param {{askPassword:(incorrect:boolean)=>Promise<string|null>, onProgress?:(fraction:number)=>void}} opts
 */
export async function loadPdf(blob, { askPassword, onProgress } = {}) {
  let magicOk;
  try {
    magicOk = await hasPdfMagic(blob);
  } catch (e) {
    throw new LoadError('unknown', e);
  }
  if (!magicOk) throw new LoadError('not-pdf');

  let data;
  try {
    data = new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    throw new LoadError(isOutOfMemory(e) ? 'too-big' : 'unknown', e);
  }

  let cancelled = false;
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: new URL('cmaps/', VENDOR).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
    wasmUrl: new URL('wasm/', VENDOR).href,
    iccUrl: new URL('iccs/', VENDOR).href,
    stopAtErrors: false,
  });

  task.onPassword = (updatePassword, reason) => {
    const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    Promise.resolve(askPassword ? askPassword(incorrect) : null).then((pw) => {
      if (pw == null) {
        cancelled = true;
        task.destroy();
      } else {
        updatePassword(pw);
      }
    });
  };

  if (onProgress) {
    task.onProgress = ({ loaded, total }) => {
      if (total > 0) onProgress(Math.min(1, loaded / total));
    };
  }

  try {
    return await task.promise;
  } catch (e) {
    if (cancelled) throw new LoadError('cancelled', e);
    if (isOutOfMemory(e)) throw new LoadError('too-big', e);
    const name = e && e.name;
    if (name === 'InvalidPDFException' || name === 'FormatError') throw new LoadError('corrupt', e);
    throw new LoadError('unknown', e);
  }
}

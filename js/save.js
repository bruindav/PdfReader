// fix-1
// fix-2: savePdf/sharePdf accepteren ook een Promise<Blob> (PDF met aantekeningen wordt nog gemaakt):
//        de bestandskiezer wordt dan eerst geopend (binnen de gebruikersactie) en daarna pas geschreven.
// Module "save": opslaan van de originele bytes, met feature-detectie.
// Volgorde: 1) showSaveFilePicker  2) Web Share met bestand  3) <a download>.

const INVALID = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Maakt een veilige basisnaam (zonder .pdf). */
export function sanitizeBaseName(name) {
  return String(name || '')
    .replace(/\.pdf$/i, '')
    .replace(INVALID, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 180);
}

export function defaultBaseName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `document-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export const hasSavePicker = () => typeof window.showSaveFilePicker === 'function';

export function canShareFile(blob, name = 'document.pdf') {
  try {
    if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return false;
    const file = new File([blob], name, { type: 'application/pdf' });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Welke route wordt gebruikt (voor de hulptekst). */
export function saveRoute(blob) {
  if (hasSavePicker()) return 'picker';
  if (canShareFile(blob)) return 'share';
  return 'download';
}

const isAbort = (e) => e && e.name === 'AbortError';

/**
 * Slaat op. Moet direct vanuit een gebruikersactie worden aangeroepen
 * (picker en share vereisen een user gesture).
 * @returns {Promise<'saved'|'shared'|'downloaded'|'cancelled'>}
 */
export async function savePdf(blobOrPromise, fileName) {
  const getBlob = async () => {
    const b = await blobOrPromise;
    return b.type === 'application/pdf' ? b : new Blob([b], { type: 'application/pdf' });
  };
  // Is de inhoud al klaar, dan meteen; anders pas na de kiezer.
  let pdfBlob = blobOrPromise instanceof Blob ? await getBlob() : null;

  if (hasSavePicker()) {
    let handle = null;
    try {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'PDF-document', accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e instanceof TypeError) {
          // Sommige platformen (Android) ondersteunen `types` niet.
          handle = await window.showSaveFilePicker({ suggestedName: fileName });
        } else {
          throw e;
        }
      }
      if (!pdfBlob) pdfBlob = await getBlob();
      const writable = await handle.createWritable();
      await writable.write(pdfBlob);
      await writable.close();
      return 'saved';
    } catch (e) {
      if (isAbort(e)) return 'cancelled';
      if (e && e.name === 'ExportError') throw e;
      // Andere fout: val terug op de volgende route.
    }
  }

  if (!pdfBlob) pdfBlob = await getBlob();
  if (canShareFile(pdfBlob, fileName)) {
    try {
      await sharePdf(pdfBlob, fileName);
      return 'shared';
    } catch (e) {
      if (isAbort(e)) return 'cancelled';
      // NotAllowedError e.d.: download als laatste redmiddel.
    }
  }

  download(pdfBlob, fileName);
  return 'downloaded';
}

export async function sharePdf(blobOrPromise, fileName) {
  const blob = await blobOrPromise;
  const file = new File([blob], fileName, { type: 'application/pdf' });
  await navigator.share({ files: [file], title: fileName });
}

export function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

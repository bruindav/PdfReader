// fix-6
// "Recent geopend": de laatste 6 PDF's snel weer openen, zonder door mappen te zoeken.
// - Startscherm: sectie met de lijst. Met een open document: ⋮-menu → "Recent geopend" (dialoog).
// - Bewaart een kopie van de originele bytes (zie recent-store.js), een miniatuur van pagina 1
//   (niet bij PDF's die een wachtwoord vroegen) en naam, grootte, datum en aantal pagina's.
// - Schakelaar "Recente documenten onthouden" (standaard aan); uitzetten wist de lijst.
// Veiligheid: alle tekst via textContent; miniaturen via object-URL's die direct weer worden vrijgegeven.
import { pdfjsLib } from './loader.js';
import { getFlag, setFlag } from './storage.js';
import {
  listRecent, getRecent, getBytes, putRecent, removeRecent, clearRecent, MAX_BYTES, MAX_RECENT,
} from './recent-store.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const THUMB_W = 160;
const FLAG = 'recent';

const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** "vandaag 21:30", "gisteren", "12 nov" of "12 nov 2025". */
export function formatWhen(ts, now = Date.now()) {
  const d = new Date(ts);
  const n = new Date(now);
  const dag = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dag(n) - dag(d)) / 86400000);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff <= 0) return `vandaag ${hm}`;
  if (diff === 1) return 'gisteren';
  const kort = `${d.getDate()} ${MAANDEN[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? kort : `${kort} ${d.getFullYear()}`;
}

const paginas = (n) => (n === 1 ? '1 pagina' : `${n} pagina's`);

export const isEnabled = () => getFlag(FLAG) !== false;

/** Miniatuur van pagina 1 (~160px breed) als WebP (of JPEG). */
async function makeThumb(pdf) {
  const page = await pdf.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: THUMB_W / vp1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.min(Math.round(vp.height), THUMB_W * 2));
  const ctx = canvas.getContext('2d', { alpha: false });
  try {
    await page.render({
      canvasContext: ctx, canvas, viewport: vp, background: '#FFFFFF',
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    }).promise;
    const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
    let blob = await toBlob('image/webp', 0.75);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.8);
    return blob && blob.size < 200 * 1024 ? blob : null;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/**
 * @param {{openBlob:(blob:Blob,name:string)=>Promise<void>, currentKey:()=>string|null,
 *          rememberCurrent:()=>void, confirm:Function, toast:Function, announce:Function, openDialog:Function}} deps
 */
export function initRecent(deps) {
  const { openBlob, currentKey, rememberCurrent, confirm, toast, announce, openDialog } = deps;
  const startSectie = $('recent-start');
  const dlg = $('dlg-recent');
  const schakelaar = $('recent-aan');
  const leeg = $('recent-leeg');
  const lijsten = [...document.querySelectorAll('[data-recent-lijst]')];
  const urls = new Set();
  let queue = Promise.resolve();
  let teGrootGemeld = false;
  let volGemeld = false;
  let renderSeq = 0;

  const serial = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  function revokeAll() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
  }

  function icon(id, cls = 'icon') {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  function rij(item, now) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.dataset.key = item.key;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-open';
    const mini = document.createElement('span');
    mini.className = 'recent-mini';
    if (item.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      const u = URL.createObjectURL(item.thumb);
      urls.add(u);
      const vrij = () => { URL.revokeObjectURL(u); urls.delete(u); };
      img.addEventListener('load', vrij, { once: true });
      img.addEventListener('error', () => { vrij(); img.remove(); mini.append(icon('i-logo', 'icon recent-mini-icoon')); }, { once: true });
      img.src = u;
      mini.append(img);
    } else {
      mini.append(icon(item.locked ? 'i-lock' : 'i-logo', 'icon recent-mini-icoon'));
    }
    const tekst = document.createElement('span');
    tekst.className = 'recent-tekst';
    const naam = document.createElement('span');
    naam.className = 'recent-naam';
    naam.textContent = item.name || 'Naamloos document';
    naam.title = item.name || '';
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    const delen = [formatWhen(item.openedAt, now)];
    if (item.pages) delen.push(paginas(item.pages));
    if (item.locked) delen.push('beveiligd');
    meta.textContent = delen.join(' · ');
    tekst.append(naam, meta);
    open.append(mini, tekst);
    open.addEventListener('click', () => openItem(item));

    const weg = document.createElement('button');
    weg.type = 'button';
    weg.className = 'knop-icoon recent-weg';
    weg.title = 'Uit lijst verwijderen';
    weg.setAttribute('aria-label', `Uit lijst verwijderen: ${item.name || 'Naamloos document'}`);
    weg.append(icon('i-close'));
    weg.addEventListener('click', () => verwijder(item, li));

    li.append(open, weg);
    return li;
  }

  async function render() {
    const seq = ++renderSeq;
    const aan = isEnabled();
    const items = aan ? await listRecent() : [];
    if (seq !== renderSeq) return;
    revokeAll();
    const now = Date.now();
    for (const ul of lijsten) {
      ul.replaceChildren(...items.map((it) => rij(it, now)));
      ul.hidden = !items.length;
    }
    startSectie.hidden = !items.length;
    document.getElementById('start').classList.toggle('heeft-recent', items.length > 0);
    for (const b of document.querySelectorAll('[data-recent-wis]')) b.hidden = !items.length;
    schakelaar.checked = aan;
    leeg.hidden = items.length > 0;
    leeg.textContent = aan
      ? `Nog geen documenten. De laatste ${MAX_RECENT} PDF's die je opent verschijnen hier.`
      : 'Recente documenten worden niet onthouden. Zet de schakelaar aan om de laatste PDF\'s hier te zien.';
  }

  async function openItem(item) {
    if (dlg.open) dlg.close('ok');
    if (item.key === currentKey()) return; // staat al open
    let blob = null;
    try { blob = await getBytes(item.key); } catch { blob = null; }
    if (!blob) {
      await removeRecent(item.key).catch(() => {});
      toast('Dit document is niet meer beschikbaar op dit toestel. Open het opnieuw via PDF openen.', { type: 'fout', duration: 8000 });
      render();
      return;
    }
    const name = item.name || 'document.pdf';
    await openBlob(new File([blob], name, { type: 'application/pdf' }), name);
  }

  async function verwijder(item, li) {
    // Focus naar een logische plek: volgende of vorige rij, anders de kop/het startscherm.
    const ul = li.parentElement;
    const buren = ul ? [...ul.children] : [];
    const i = buren.indexOf(li);
    const volgende = buren[i + 1] || buren[i - 1] || null;
    const key = volgende ? volgende.dataset.key : null;
    const inDialoog = dlg.contains(li);
    await serial(() => removeRecent(item.key)).catch(() => {});
    await render();
    announce(`${item.name || 'Document'} verwijderd uit de lijst`);
    const doel = key && [...(inDialoog ? dlg : startSectie).querySelectorAll('.recent-item')].find((x) => x.dataset.key === key);
    if (doel) doel.querySelector('.recent-weg').focus();
    else if (inDialoog) $('dlg-recent-sluit').focus();
    else $('btn-open-groot').focus();
  }

  async function wisLijst() {
    const ok = await confirm({
      title: 'Lijst wissen?',
      text: 'De lijst "Recent geopend" en de kopieën van deze PDF\'s worden van dit toestel verwijderd. Je originele bestanden en je aantekeningen blijven bewaard.',
      ok: 'Lijst wissen',
    });
    if (!ok) return;
    await serial(() => clearRecent()).catch(() => {});
    await render();
    toast('Lijst "Recent geopend" gewist.', { type: 'succes' });
  }

  for (const b of document.querySelectorAll('[data-recent-wis]')) b.addEventListener('click', wisLijst);

  schakelaar.addEventListener('change', async () => {
    const aan = schakelaar.checked;
    setFlag(FLAG, aan);
    if (!aan) {
      await serial(() => clearRecent()).catch(() => {});
      announce('Recente documenten worden niet meer onthouden. De lijst is gewist.');
    } else {
      announce('Recente documenten worden onthouden.');
      rememberCurrent();
    }
    render();
  });

  function show() {
    render().then(() => {
      openDialog(dlg, { focus: dlg.querySelector('.recent-open') || schakelaar });
    });
  }

  /**
   * Na het openen van een document: bovenaan zetten (en de bytes bewaren).
   * @param {{key:string, name:string, blob:Blob, pdf:object, pages:number, locked:boolean}} d
   */
  function remember({ key, name, blob, pdf, pages, locked }) {
    if (!isEnabled() || !key || !blob) return Promise.resolve();
    if (blob.size > MAX_BYTES) {
      if (!teGrootGemeld) {
        teGrootGemeld = true;
        toast(`Deze PDF is groter dan ${Math.round(MAX_BYTES / 1048576)} MB en wordt daarom niet bewaard in Recent geopend.`, { duration: 8000 });
      }
      return Promise.resolve();
    }
    return serial(async () => {
      const bestaand = await getRecent(key);
      let thumb = !locked && bestaand ? bestaand.thumb : null;
      if (!thumb && !locked && pdf) {
        try { thumb = await makeThumb(pdf); } catch { thumb = null; }
      }
      if (!isEnabled()) return; // tussendoor uitgezet
      const zelfdeBytes = bestaand && bestaand.size === blob.size && (await getBytes(key).catch(() => null));
      try {
        await putRecent({ key, name, size: blob.size, openedAt: Date.now(), pages, locked, thumb }, zelfdeBytes ? null : blob);
      } catch {
        if (!volGemeld) {
          volGemeld = true;
          toast('Er is niet genoeg opslagruimte op dit toestel om deze PDF te bewaren in Recent geopend.', { duration: 8000 });
        }
        return;
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    }).then(render, render);
  }

  /** Wist de lijst (privacypagina / "Geschiedenis wissen"). */
  async function clear() {
    await serial(() => clearRecent()).catch(() => {});
    await render();
  }

  window.addEventListener('pagehide', revokeAll);
  render();
  return { remember, show, clear, render };
}

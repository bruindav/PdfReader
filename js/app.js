// fix-1
// PdfReader – hoofdmodule: koppelt UI, loader, viewer, opslaan en service worker.
import { bus } from './eventbus.js';
import { loadPdf, LoadError } from './loader.js';
import { Viewer, ZOOM_MIN, ZOOM_MAX } from './viewer.js';
import { savePdf, sharePdf, saveRoute, canShareFile, sanitizeBaseName, defaultBaseName } from './save.js';
import { getZoomPref, setZoomPref, getDocState, setDocState, clearHistory } from './storage.js';
import { announce, toast, openDialog, anyDialogOpen, wireDialogCloseButtons, setDisabled } from './ui.js';
import { initInstall, isIOS, maybeShowIosHelpOnce } from './install.js';

const $ = (id) => document.getElementById(id);

const els = {
  lezer: $('lezer'),
  paginas: $('paginas'),
  start: $('start'),
  laden: $('laden'),
  spinner: $('spinner-vak'),
  voortgang: $('voortgang'),
  fout: $('fout'),
  foutOorzaak: $('fout-oorzaak'),
  titel: $('titel'),
  input: $('bestand'),
  btnOpen: $('btn-open'),
  btnOpenGroot: $('btn-open-groot'),
  btnOpenFout: $('btn-open-fout'),
  btnKleiner: $('btn-kleiner'),
  btnGroter: $('btn-groter'),
  btnZoom: $('btn-zoom'),
  zoomWaarde: $('zoom-waarde'),
  btnBreedte: $('btn-breedte'),
  btnOpslaan: $('btn-opslaan'),
  tellers: [$('teller-kop'), $('teller-balk')],
  zoommenu: $('zoommenu'),
  overlay: $('dropoverlay'),
};

const MESSAGES = {
  'not-pdf': 'Dit is geen PDF-bestand. Kies een bestand dat eindigt op .pdf.',
  corrupt: 'Het bestand is beschadigd of onvolledig.',
  'too-big': 'Het bestand is te groot om op dit toestel te openen.',
  unknown: 'Er ging iets mis. Probeer het opnieuw of kies een ander bestand.',
  missing: 'Het gedeelde bestand is niet meer beschikbaar. Deel het opnieuw.',
};

const viewer = new Viewer(els.lezer, els.paginas);
const isMobileLayout = () => matchMedia('(max-width: 719.98px)').matches;

/** Huidig document: originele Blob (ongewijzigd) + naam + fingerprint. */
let doc = null;
let loadSeq = 0;
let suppressPref = false;

// ---------- Toestanden ----------

function showState(state) {
  els.start.hidden = state !== 'start';
  els.laden.hidden = state !== 'laden';
  els.fout.hidden = state !== 'fout';
  els.paginas.hidden = state !== 'lezen';
  updateToolbar();
}

function updateToolbar() {
  const open = viewer.isOpen && !els.paginas.hidden;
  setDisabled(els.btnKleiner, !open || !viewer.canZoomOut);
  setDisabled(els.btnGroter, !open || !viewer.canZoomIn);
  setDisabled(els.btnZoom, !open);
  setDisabled(els.btnBreedte, !open);
  setDisabled(els.btnOpslaan, !open || !doc);
  for (const t of els.tellers) setDisabled(t, !open);

  if (open) {
    const pct = Math.round(viewer.scale * 100);
    els.zoomWaarde.textContent = `${pct}%`;
    els.btnZoom.setAttribute('aria-label', `Zoom ${pct} procent. Kies passend op breedte`);
    const label = `${viewer.current} / ${viewer.pageCount}`;
    for (const t of els.tellers) {
      t.textContent = label;
      t.setAttribute('aria-label', `Pagina ${viewer.current} van ${viewer.pageCount}. Ga naar pagina`);
    }
  } else {
    els.zoomWaarde.textContent = '100%';
    els.btnZoom.setAttribute('aria-label', 'Zoom 100 procent. Kies passend op breedte');
    for (const t of els.tellers) {
      t.textContent = '– / –';
      t.setAttribute('aria-label', 'Ga naar pagina');
    }
  }
}

function setTitle(name) {
  els.titel.textContent = name || 'PdfReader';
  els.titel.title = name || '';
  document.title = name ? `${name} – PdfReader` : 'PdfReader';
}

// ---------- Openen ----------

function pickFile() {
  els.input.value = '';
  els.input.click();
}

/**
 * Opent een bestand (Blob/File). Vervangt het huidige document pas als het nieuwe goed laadt.
 */
async function openBlob(blob, name) {
  const seq = ++loadSeq;
  const hadDoc = !!doc;
  const prevState = hadDoc ? 'lezen' : (els.fout.hidden ? 'start' : 'fout');
  closeZoomMenu();

  if (!hadDoc) showState('laden');
  els.spinner.classList.add('verborgen');
  els.voortgang.hidden = true;
  const spinTimer = setTimeout(() => {
    if (!hadDoc) els.spinner.classList.remove('verborgen');
  }, 300);

  let pdf;
  try {
    pdf = await loadPdf(blob, {
      askPassword,
      onProgress: (f) => {
        els.voortgang.hidden = false;
        els.voortgang.value = Math.round(f * 100);
      },
    });
  } catch (e) {
    clearTimeout(spinTimer);
    if (seq !== loadSeq) return;
    const code = e instanceof LoadError ? e.code : 'unknown';
    if (code === 'cancelled') {
      showState(prevState);
      return;
    }
    showError(code, hadDoc);
    return;
  }
  clearTimeout(spinTimer);
  if (seq !== loadSeq) { pdf.destroy(); return; }

  const fileName = name || (blob && blob.name) || '';
  const fp = (pdf.fingerprints && pdf.fingerprints[0]) || null;
  const saved = fp ? getDocState(fp) : null;
  const zoom = (saved && saved.zoom) || getZoomPref() || (isMobileLayout() ? 'width' : 'auto');

  doc = { blob, name: fileName, fp };
  setTitle(fileName || 'Naamloos document');
  showState('lezen');
  suppressPref = true;
  try {
    await viewer.open(pdf, { page: saved ? saved.page : 1, zoom });
  } catch (e) {
    suppressPref = false;
    doc = null;
    setTitle('');
    showError('corrupt', false);
    return;
  }
  suppressPref = false;
  updateToolbar();
  announce(`PDF geopend, ${viewer.pageCount} ${viewer.pageCount === 1 ? 'pagina' : "pagina's"}`);
  bus.emit('document-loaded', { name: fileName, pages: viewer.pageCount, fingerprint: fp });
}

function showError(code, keepDoc) {
  const text = MESSAGES[code] || MESSAGES.unknown;
  if (keepDoc && doc) {
    showState('lezen');
    toast(`Dit bestand kan niet worden geopend. ${text}`, { type: 'fout' });
    return;
  }
  viewer.close();
  doc = null;
  setTitle('');
  els.foutOorzaak.textContent = text;
  showState('fout');
  els.btnOpenFout.focus({ preventScroll: true });
}

// ---------- Wachtwoord ----------

function askPassword(incorrect) {
  return new Promise((resolve) => {
    const dlg = $('dlg-wachtwoord');
    const form = $('form-wachtwoord');
    const input = $('ww-invoer');
    const err = $('ww-fout');
    const toggle = $('ww-toon');
    input.value = '';
    input.type = 'password';
    toggle.textContent = 'Toon';
    toggle.setAttribute('aria-pressed', 'false');
    err.textContent = incorrect ? 'Wachtwoord klopt niet. Probeer het opnieuw.' : '';
    input.setAttribute('aria-invalid', String(!!incorrect));

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      input.value = '';
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const value = input.value;
      finish(value);
      dlg.close('ok');
    };
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    openDialog(dlg, { focus: input });
  });
}

$('ww-toon').addEventListener('click', () => {
  const input = $('ww-invoer');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('ww-toon').textContent = show ? 'Verberg' : 'Toon';
  $('ww-toon').setAttribute('aria-pressed', String(show));
  input.focus();
});

// ---------- Zoom ----------

function zoomTo(mode) {
  viewer.setZoom(mode);
}

bus.on('zoom-changed', ({ mode, scale, live }) => {
  updateToolbar();
  if (live || suppressPref) return;
  setZoomPref(mode);
  persistDoc();
  announce(mode === 'width' ? 'Passend op breedte' : `Zoom ${Math.round(scale * 100)} procent`, 500);
});

let persistTimer = 0;
function persistDoc() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (doc && doc.fp && viewer.isOpen) setDocState(doc.fp, viewer.current, viewer.mode);
  }, 400);
}

bus.on('page-changed', () => {
  updateToolbar();
  persistDoc();
});

els.btnKleiner.addEventListener('click', () => viewer.zoomOut());
els.btnGroter.addEventListener('click', () => viewer.zoomIn());
els.btnBreedte.addEventListener('click', () => zoomTo('width'));

function openZoomMenu() {
  const menu = els.zoommenu;
  const r = els.btnZoom.getBoundingClientRect();
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.left + r.width / 2 - mw / 2));
  menu.style.left = `${left}px`;
  if (r.top > window.innerHeight / 2) {
    menu.style.top = '';
    menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  } else {
    menu.style.bottom = '';
    menu.style.top = `${r.bottom + 8}px`;
  }
  els.btnZoom.setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}

function closeZoomMenu(returnFocus = false) {
  if (els.zoommenu.hidden) return;
  els.zoommenu.hidden = true;
  els.btnZoom.setAttribute('aria-expanded', 'false');
  if (returnFocus) els.btnZoom.focus();
}

els.btnZoom.addEventListener('click', () => {
  if (els.zoommenu.hidden) openZoomMenu(); else closeZoomMenu();
});
els.zoommenu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-zoom]');
  if (!b) return;
  const v = b.dataset.zoom;
  closeZoomMenu(true);
  zoomTo(v === 'width' || v === 'page' ? v : Number(v));
});
els.zoommenu.addEventListener('keydown', (e) => {
  const items = [...els.zoommenu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeZoomMenu(true); }
  else if (e.key === 'Tab') closeZoomMenu();
});
document.addEventListener('pointerdown', (e) => {
  if (!els.zoommenu.hidden && !els.zoommenu.contains(e.target) && !els.btnZoom.contains(e.target)) closeZoomMenu();
});

// ---------- Ga naar pagina ----------

function openGoto() {
  if (!viewer.isOpen) return;
  const n = viewer.pageCount;
  $('pagina-label').textContent = `Paginanummer (1 – ${n})`;
  const input = $('pagina-invoer');
  input.value = String(viewer.current);
  input.removeAttribute('aria-invalid');
  $('pagina-fout').textContent = '';
  openDialog($('dlg-pagina'), { focus: input });
}

$('form-pagina').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = viewer.pageCount;
  const input = $('pagina-invoer');
  const v = input.value.trim();
  const num = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(num) || num < 1 || num > n) {
    $('pagina-fout').textContent = `Kies een pagina van 1 tot en met ${n}.`;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  const dlg = $('dlg-pagina');
  // Na het sluiten de focus naar het leesgebied (na het standaard terugzetten naar de opener).
  dlg.addEventListener('close', () => els.lezer.focus({ preventScroll: true }), { once: true });
  dlg.close('ok');
  viewer.goToPage(num);
  announce(`Pagina ${num} van ${n}`);
});
for (const t of els.tellers) t.addEventListener('click', openGoto);

// ---------- Opslaan ----------

function suggestedBase() {
  return sanitizeBaseName(doc && doc.name) || defaultBaseName();
}

function openSave() {
  if (!doc) return;
  const input = $('naam-invoer');
  input.value = suggestedBase();
  input.removeAttribute('aria-invalid');
  $('naam-fout').textContent = '';
  const route = saveRoute(doc.blob);
  $('opslaan-hulp').textContent =
    route === 'picker' ? 'Je kiest hierna zelf de map.'
      : route === 'share' ? 'Kies hierna "Bewaar in Bestanden" (iPhone) of een app of map.'
        : 'Het bestand komt in je map Downloads.';
  $('btn-delen').hidden = !canShareFile(doc.blob);
  openDialog($('dlg-opslaan'), { focus: input });
}

function readSaveName() {
  const input = $('naam-invoer');
  const base = sanitizeBaseName(input.value);
  if (!base) {
    $('naam-fout').textContent = 'Vul een bestandsnaam in.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return null;
  }
  return `${base}.pdf`;
}

$('naam-invoer').addEventListener('input', (e) => {
  const el = e.target;
  const cleaned = el.value.replace(/[\\/:*?"<>|]/g, '-');
  if (cleaned !== el.value) {
    const pos = el.selectionStart;
    el.value = cleaned;
    el.setSelectionRange(pos, pos);
  }
  if (el.value.trim()) { $('naam-fout').textContent = ''; el.removeAttribute('aria-invalid'); }
});

$('form-opslaan').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = readSaveName();
  if (!name || !doc) return;
  $('dlg-opslaan').close('ok');
  try {
    // Direct (binnen de gebruikersactie) aanroepen: picker/share vereisen dat.
    const result = await savePdf(doc.blob, name);
    if (result === 'saved') {
      toast(`Opgeslagen als ${name}`, { type: 'succes' });
      announce(`Opgeslagen als ${name}`);
    }
  } catch {
    toast('Opslaan is niet gelukt. Probeer het opnieuw.', { type: 'fout' });
  }
});

$('btn-delen').addEventListener('click', async () => {
  const name = readSaveName();
  if (!name || !doc) return;
  $('dlg-opslaan').close('ok');
  try {
    await sharePdf(doc.blob, name);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    toast('Opslaan is niet gelukt. Probeer het opnieuw.', { type: 'fout' });
  }
});

// ---------- Help ----------

function openHelp() {
  $('help-ios').hidden = !isIOS;
  $('help-delen').textContent = isIOS
    ? 'Op de iPhone kan een web-app geen bestanden uit andere apps ontvangen. Zo gaat het snel:'
    : 'Installeer PdfReader als app. Daarna kun je op Android een PDF vanuit een andere app delen met PdfReader, en op de computer een PDF openen via "Openen met".';
  openDialog($('dlg-help'));
}
$('link-help').addEventListener('click', openHelp);
$('btn-wis').addEventListener('click', () => {
  clearHistory();
  toast('Geschiedenis gewist.', { type: 'succes' });
});

// ---------- Knoppen openen ----------

for (const b of [els.btnOpen, els.btnOpenGroot, els.btnOpenFout]) b.addEventListener('click', pickFile);
els.input.addEventListener('change', () => {
  const f = els.input.files && els.input.files[0];
  els.input.value = ''; // zelfde bestand opnieuw kiezen moet weer werken
  if (f) openBlob(f, f.name);
});
els.btnOpslaan.addEventListener('click', openSave);

// ---------- Slepen ----------

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.overlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.overlay.hidden = true;
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openBlob(f, f.name);
});

// ---------- Toetsenbord ----------

document.addEventListener('keydown', (e) => {
  if (anyDialogOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  const tag = e.target && e.target.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); pickFile(); return; }
    if (!viewer.isOpen) return;
    if (k === '+' || k === '=' || e.code === 'NumpadAdd') { e.preventDefault(); viewer.zoomIn(); return; }
    if (k === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); viewer.zoomOut(); return; }
    if (k === '0' || e.code === 'Numpad0') { e.preventDefault(); zoomTo('width'); return; }
    if (k === 's') { e.preventDefault(); openSave(); return; }
    if (k === 'g') { e.preventDefault(); openGoto(); return; }
    return;
  }
  if (e.key === 'Escape') { closeZoomMenu(true); return; }
  if (!viewer.isOpen || inField || e.altKey) return;
  const onButton = tag === 'BUTTON' || tag === 'A';
  const sc = els.lezer;
  const canScrollX = sc.scrollWidth > sc.clientWidth + 1;
  switch (e.key) {
    case 'PageDown': e.preventDefault(); viewer.nextPage(1); break;
    case 'PageUp': e.preventDefault(); viewer.nextPage(-1); break;
    case ' ':
      if (onButton) return;
      e.preventDefault(); viewer.nextPage(e.shiftKey ? -1 : 1); break;
    case 'ArrowDown': if (onButton) return; e.preventDefault(); sc.scrollTop += 40; break;
    case 'ArrowUp': if (onButton) return; e.preventDefault(); sc.scrollTop -= 40; break;
    case 'ArrowRight':
      if (onButton) return;
      e.preventDefault();
      if (canScrollX) sc.scrollLeft += 40; else viewer.nextPage(1);
      break;
    case 'ArrowLeft':
      if (onButton) return;
      e.preventDefault();
      if (canScrollX) sc.scrollLeft -= 40; else viewer.nextPage(-1);
      break;
    case 'Home': if (onButton) return; e.preventDefault(); viewer.goToPage(1); break;
    case 'End': if (onButton) return; e.preventDefault(); viewer.goToPage(viewer.pageCount); break;
    default: return;
  }
});

// ---------- Bestanden van buiten (share_target, file_handlers) ----------

async function takeSharedFile() {
  const params = new URLSearchParams(location.search);
  if (params.get('shared') !== '1') return false;
  history.replaceState(null, '', './');
  let blob = null;
  let name = '';
  try {
    if ('caches' in window) {
      const cache = await caches.open('pdfreader-share');
      const res = await cache.match('shared-file');
      if (res) {
        try { name = decodeURIComponent(res.headers.get('X-Filename') || ''); } catch { name = ''; }
        blob = await res.blob();
      }
      await cache.delete('shared-file');
    }
  } catch { /* negeren */ }
  if (!blob) {
    showError('missing', false);
    return true;
  }
  const file = new File([blob], name || 'gedeeld.pdf', { type: blob.type || 'application/pdf' });
  await openBlob(file, file.name);
  return true;
}

function initLaunchQueue() {
  if (!('launchQueue' in window) || typeof window.launchQueue.setConsumer !== 'function') return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    try {
      const file = await params.files[0].getFile();
      openBlob(file, file.name);
    } catch {
      showError('unknown', !!doc);
    }
  });
}

// ---------- Service worker ----------

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  let userRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userRequested || reloading) return;
    reloading = true;
    location.reload();
  });
  const offerUpdate = (worker) => {
    toast('Nieuwe versie beschikbaar – herladen', {
      duration: 0,
      action: {
        label: 'Herladen',
        onClick: () => { userRequested = true; worker.postMessage({ type: 'SKIP_WAITING' }); },
      },
    });
  };
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch(() => { /* offline-functie niet beschikbaar; app werkt verder */ });
}

// ---------- Start ----------

wireDialogCloseButtons();
initInstall();
initLaunchQueue();
initServiceWorker();
showState('start');
takeSharedFile().then((shared) => {
  if (!shared) maybeShowIosHelpOnce(openHelp);
});

// Voor tests en latere modules (bijv. annotaties).
window.pdfReader = Object.freeze({ viewer, bus, ZOOM_MIN, ZOOM_MAX });

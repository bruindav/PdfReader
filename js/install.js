// fix-1
// Installatie-hint en installatieknop (beforeinstallprompt waar beschikbaar).
import { getFlag, setFlag } from './storage.js';
import { openDialog } from './ui.js';

const $ = (id) => document.getElementById(id);
let deferredPrompt = null;

export const isStandalone = () =>
  (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
  navigator.standalone === true;

// Platformdetectie alleen voor de juiste uitleg (functies zelf gebruiken feature-detectie).
const ua = navigator.userAgent || '';
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
const isAndroid = /Android/i.test(ua);

function li(text) {
  const el = document.createElement('li');
  el.textContent = text;
  return el;
}
function p(text) {
  const el = document.createElement('p');
  el.textContent = text;
  return el;
}

function fillDialog() {
  const box = $('inst-inhoud');
  box.replaceChildren();
  const promptBtn = $('inst-prompt');
  const nietNu = $('inst-nietnu');
  const begrepen = $('inst-begrepen');
  promptBtn.hidden = true;
  nietNu.hidden = true;
  begrepen.hidden = false;

  if (isStandalone()) {
    box.append(p('PdfReader is al geïnstalleerd als app.'));
    return;
  }
  if (isIOS) {
    if (isIOSSafari) {
      const ol = document.createElement('ol');
      ol.append(
        li('Tik onderin op Deel (vierkantje met pijl omhoog).'),
        li('Kies "Zet op beginscherm".'),
        li('Tik op "Voeg toe".'),
      );
      box.append(ol);
    } else {
      box.append(p('Open deze pagina in Safari om hem op je beginscherm te zetten.'));
    }
    return;
  }
  if (deferredPrompt) {
    promptBtn.hidden = false;
    nietNu.hidden = false;
    begrepen.hidden = true;
    box.append(p('Installeer PdfReader als app. Hij werkt dan ook zonder internet.'));
  } else if (isAndroid) {
    box.append(p('Tik rechtsboven op ⋮ en kies "App installeren" of "Toevoegen aan startscherm".'));
  } else {
    box.append(p('Klik in de adresbalk op het installatie-icoon, of kies in het menu "App installeren".'));
  }
  if (isAndroid) box.append(p('Daarna kun je een PDF vanuit andere apps naar PdfReader delen.'));
}

export function showInstallDialog() {
  fillDialog();
  openDialog($('dlg-installeer'));
}

async function runPrompt() {
  if (!deferredPrompt) { showInstallDialog(); return; }
  const ev = deferredPrompt;
  deferredPrompt = null;
  updateButtons();
  try {
    await ev.prompt();
    await ev.userChoice;
  } catch { /* negeren */ }
  if ($('dlg-installeer').open) $('dlg-installeer').close();
}

function updateButtons() {
  const show = !!deferredPrompt && !isStandalone();
  $('btn-installeer').hidden = !show;
  $('btn-installeer-start').hidden = !show;
}

export function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    updateButtons();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    updateButtons();
    $('installbanner').hidden = true;
  });

  $('btn-installeer').addEventListener('click', runPrompt);
  $('btn-installeer-start').addEventListener('click', runPrompt);
  $('inst-prompt').addEventListener('click', runPrompt);
  $('link-installeer').addEventListener('click', showInstallDialog);
  $('banner-meer').addEventListener('click', () => {
    $('installbanner').hidden = true;
    setFlag('bannerGesloten', true);
    if (deferredPrompt) runPrompt(); else showInstallDialog();
  });
  $('banner-sluit').addEventListener('click', () => {
    $('installbanner').hidden = true;
    setFlag('bannerGesloten', true);
  });

  if (isStandalone()) {
    $('link-installeer').hidden = true;
    return;
  }
  // Banner eenmalig vanaf het 2e gebruik.
  const uses = (Number(getFlag('gebruik')) || 0) + 1;
  setFlag('gebruik', uses);
  if (uses >= 2 && !getFlag('bannerGesloten')) $('installbanner').hidden = false;
}

/** iOS: uitleg over PDF's uit andere apps eenmalig tonen (daarna via Help). */
export function maybeShowIosHelpOnce(showHelp) {
  if (!isIOS || getFlag('iosHelpGetoond')) return;
  setFlag('iosHelpGetoond', true);
  showHelp();
}

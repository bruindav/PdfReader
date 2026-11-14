// fix-5
// ⋮-menu en het info-venster: help.html, privacy.html en disclaimer.html openen in een volledig scherm
// (iframe, zelfde origin) bovenop de app. Zo blijft een geopende PDF open. De terugknop van de
// browser/Android-app sluit het venster (history.pushState + popstate).
import { VERSIE } from './versie.js';

const $ = (id) => document.getElementById(id);
const PAGINAS = new Set(['help.html', 'privacy.html', 'disclaimer.html']);
const STATE = 'pdfreaderInfo';

/** Alleen eigen info-pagina's, eventueel met #anker; alles anders wordt geweigerd. */
function veiligAdres(href) {
  const [pad, anker = ''] = String(href).split('#');
  if (!PAGINAS.has(pad) || !/^[a-z0-9-]*$/.test(anker)) return null;
  return `${pad}?ingebed=1${anker ? `#${anker}` : ''}`;
}

export function initInfo({ onWis, beforeOpen = () => {} } = {}) {
  const dlg = $('dlg-info');
  let frame = $('info-frame');
  const titel = $('info-titel');
  const btnMeer = $('btn-meer');
  const menu = $('meermenu');

  for (const el of document.querySelectorAll('[data-versie]')) el.textContent = `(${VERSIE})`;

  // ---------- ⋮-menu ----------
  function openMenu() {
    beforeOpen();
    const r = btnMeer.getBoundingClientRect();
    menu.hidden = false;
    const mw = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
    menu.style.top = `${r.bottom + 6}px`;
    btnMeer.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
  }
  function closeMenu(returnFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    btnMeer.setAttribute('aria-expanded', 'false');
    if (returnFocus) btnMeer.focus();
  }
  btnMeer.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(); });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btnMeer.contains(e.target)) closeMenu();
  });

  // ---------- venster ----------
  function open(href) {
    const src = veiligAdres(href);
    if (!src) return;
    closeMenu();
    for (const d of document.querySelectorAll('dialog[open]')) if (d !== dlg) d.close('annuleren');
    if (!dlg.open) {
      dlg.showModal();
      history.pushState({ [STATE]: true }, '');
    }
    laad(src);
    requestAnimationFrame(() => $('info-terug').focus());
  }
  function close() {
    if (!dlg.open) return;
    dlg.close();
  }
  // Elke pagina krijgt een nieuw iframe: de eerste lading van een nieuw frame voegt niets toe aan de
  // geschiedenis (navigeren binnen een bestaand iframe wel), zodat één keer "terug" het venster sluit.
  function laad(src) {
    const nieuw = document.createElement('iframe');
    nieuw.id = 'info-frame';
    nieuw.className = frame.className;
    nieuw.title = 'Informatie';
    if (src) {
      titel.textContent = 'Laden…';
      nieuw.addEventListener('load', () => {
        try {
          const d = nieuw.contentDocument;
          if (d) titel.textContent = (d.title || '').replace(/\s*[–-]\s*PdfReader$/, '') || 'Informatie';
        } catch { /* */ }
      });
      nieuw.src = new URL(src, location.href).href;
    }
    frame.replaceWith(nieuw);
    frame = nieuw;
  }

  dlg.addEventListener('close', () => {
    laad(null);
    if (history.state && history.state[STATE]) history.back();
    btnMeer.focus({ preventScroll: true });
  });
  window.addEventListener('popstate', () => {
    if (dlg.open && !(history.state && history.state[STATE])) dlg.close();
  });
  $('info-terug').addEventListener('click', close);

  // Berichten van de ingebedde pagina (alleen eigen origin en alleen uit dit iframe).
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === 'pdfreader-info-sluit') close();
    else if (d.type === 'pdfreader-info-ga' && typeof d.href === 'string') {
      const src = veiligAdres(d.href);
      if (src) { laad(src); requestAnimationFrame(() => frame.focus()); }
    } else if (d.type === 'pdfreader-wis' && onWis) {
      // De toast valt onder het venster; daarom meldt de pagina zelf het resultaat.
      Promise.resolve(onWis()).then((done) => {
        frame.contentWindow?.postMessage({ type: 'pdfreader-gewist', done: !!done }, location.origin);
      });
    }
  });

  for (const b of document.querySelectorAll('[data-info]')) b.addEventListener('click', () => open(b.dataset.info));

  return { open, close, closeMenu };
}

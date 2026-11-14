// fix-5
// Script voor help.html, privacy.html en disclaimer.html.
// - ?ingebed=1: de pagina staat in het info-venster van de app (iframe, zelfde origin). Dan geen eigen
//   kopregel, interne links via het venster (zonder nieuwe geschiedenis-items) (de terugknop sluit dan het venster) en
//   Esc sluit het venster.
// - Vult de versie in en regelt de knop "Gegevens wissen" (alleen ingebed; de app doet het wissen).
import { VERSIE } from './versie.js';

const ingebed = new URLSearchParams(location.search).get('ingebed') === '1' && window.parent !== window;
const root = document.documentElement;
if (ingebed) root.classList.add('ingebed');

for (const el of document.querySelectorAll('[data-versie]')) el.textContent = VERSIE;

const PAGINAS = new Set(['help.html', 'privacy.html', 'disclaimer.html']);
const naarOuder = (data) => window.parent.postMessage(data, location.origin);

if (ingebed) {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const url = new URL(a.getAttribute('href'), location.href);
    if (url.origin !== location.origin) return;
    const pad = url.pathname.split('/').pop();
    if (pad === location.pathname.split('/').pop() && url.hash) {
      // Anker op dezelfde pagina: scrollen zonder geschiedenis-item.
      const doel = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (doel) {
        e.preventDefault();
        doel.scrollIntoView({ block: 'start' });
        if (!doel.hasAttribute('tabindex')) doel.setAttribute('tabindex', '-1');
        doel.focus({ preventScroll: true });
      }
      return;
    }
    if (PAGINAS.has(pad)) {
      // Het venster laadt de pagina in een nieuw frame (geen extra stap in de terug-geschiedenis).
      e.preventDefault();
      naarOuder({ type: 'pdfreader-info-ga', href: pad + url.hash });
    } else if (pad === '' || pad === 'index.html') {
      e.preventDefault();
      naarOuder({ type: 'pdfreader-info-sluit' });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); naarOuder({ type: 'pdfreader-info-sluit' }); }
  });
}

const wis = document.getElementById('wis-gegevens');
const wisStatus = document.getElementById('wis-status');
if (wis && ingebed) {
  wis.hidden = false;
  wis.addEventListener('click', () => {
    if (wisStatus) wisStatus.textContent = '';
    naarOuder({ type: 'pdfreader-wis' });
  });
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    if (e.data && e.data.type === 'pdfreader-gewist' && wisStatus) {
      wisStatus.textContent = e.data.done
        ? 'Klaar: geschiedenis en aantekeningen zijn gewist.'
        : 'Geschiedenis is gewist. Je aantekeningen zijn bewaard.';
    }
  });
}

// Als de anker-link (#over) binnenkomt in het venster: na laden naar het anker.
if (location.hash) {
  const doel = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (doel) requestAnimationFrame(() => doel.scrollIntoView({ block: 'start' }));
}

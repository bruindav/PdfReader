// fix-1
// Algemene UI-hulpjes: toasts, live-meldingen en dialogen. Alleen textContent (geen innerHTML).

const $ = (id) => document.getElementById(id);

let announceTimer = 0;
/** Voorleesmelding via de live-regio. debounce in ms (zoommeldingen 500). */
export function announce(text, debounce = 0) {
  clearTimeout(announceTimer);
  const set = () => {
    const el = $('melding');
    el.textContent = '';
    // Kleine vertraging zodat dezelfde tekst opnieuw wordt voorgelezen.
    requestAnimationFrame(() => { el.textContent = text; });
  };
  if (debounce) announceTimer = setTimeout(set, debounce); else set();
}

/**
 * Toont een toast.
 * @param {string} text
 * @param {{type?:'fout'|'succes'|'info', duration?:number, action?:{label:string,onClick:()=>void}}} opts
 */
export function toast(text, { type = 'info', duration = 6000, action = null } = {}) {
  const box = document.createElement('div');
  box.className = `toast ${type}`;
  box.setAttribute('role', type === 'fout' ? 'alert' : 'status');
  const p = document.createElement('p');
  p.textContent = text;
  box.append(p);
  const close = () => box.remove();
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { close(); action.onClick(); });
    box.append(b);
  }
  const c = document.createElement('button');
  c.type = 'button';
  c.textContent = 'Sluiten';
  c.addEventListener('click', close);
  box.append(c);
  $('toasts').append(box);
  if (duration > 0) setTimeout(close, duration);
  return close;
}

/** Opent een <dialog> modaal en geeft de focus later terug aan de opener. */
export function openDialog(dlg, { focus = null } = {}) {
  const opener = document.activeElement;
  dlg.addEventListener('close', () => {
    if (opener && typeof opener.focus === 'function' && opener.isConnected) {
      try { opener.focus({ preventScroll: true }); } catch { /* */ }
    }
  }, { once: true });
  if (!dlg.open) dlg.showModal();
  if (focus) requestAnimationFrame(() => { focus.focus(); if (focus.select) focus.select(); });
}

export function anyDialogOpen() {
  return !!document.querySelector('dialog[open]');
}

/** Koppelt alle [data-sluit]-knoppen aan het sluiten van hun dialoog. */
export function wireDialogCloseButtons() {
  for (const b of document.querySelectorAll('dialog [data-sluit]')) {
    b.addEventListener('click', () => b.closest('dialog').close('annuleren'));
  }
}

export function setDisabled(el, disabled) {
  el.disabled = disabled;
  el.setAttribute('aria-disabled', String(disabled));
}

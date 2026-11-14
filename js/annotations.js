// fix-2
// Module "annotations": tekenmodus, gereedschappen, selecteren, tekst, ongedaan maken en lokaal bewaren.
//
// Per pagina vult deze module de bestaande .annotatielaag (z-index 4) met een SVG waarvan de
// viewBox de paginagrootte in PDF-punten is; de SVG schaalt dus vanzelf mee met de zoom.
// Koppeling met de viewer loopt via de eventbus (page-rendered, zoom-changed, document-loaded).
// Alle tekst van de gebruiker gaat via textContent / SVG-tekstknopen (nooit innerHTML).
import { bus } from './eventbus.js';
import { announce, toast, setDisabled, anyDialogOpen } from './ui.js';
import { loadAnnotations, saveAnnotations, markExported, countAll, clearAll } from './annot-store.js';
import {
  PALETTE, WIDTHS, SIZES, DEFAULT_COLOR, DEFAULT_WIDTH, DEFAULT_SIZE, TYPE_NAMES, MIN_LINE, MIN_SHAPE, MAX_TEXT,
  normHex, colorName, strokeStyle, textLayout, bbox, distance, translate, clampDelta, clampPt, resize, snap45,
  boxFrom, simplify, svgPath, newId, describe, History,
} from './annot-model.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const TOOLS = ['select', 'pen', 'line', 'oval', 'rect', 'text'];
const TOOL_NAMES = { select: 'Selecteren', pen: 'Pen', line: 'Lijn', oval: 'Ovaal', rect: 'Rechthoek', text: 'Tekst' };
const TOOL_KEYS = { v: 'select', p: 'pen', l: 'line', o: 'oval', r: 'rect', t: 'text' };
const SAVE_DELAY = 500;
const LS = 'pdfreader.annot.';

function lsGet(k, fallback) {
  try {
    const v = localStorage.getItem(LS + k);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* negeren */ }
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export class Annotations {
  /**
   * @param {{viewer:any, scrollEl:HTMLElement, confirm:(o:object)=>Promise<boolean>}} o
   */
  constructor({ viewer, scrollEl, confirm }) {
    this.viewer = viewer;
    this.scrollEl = scrollEl;
    this.confirm = confirm;
    this.items = new Map();
    this.layers = new Map(); // pagina → laag
    this.history = new History(200);
    this.key = null;
    this.pdf = null;
    this.active = false;
    this.selected = null;
    this.gesture = null;
    this.editing = null;
    this.touches = new Set();
    this.gestureLock = false;
    this.penDown = false;
    this.spaceDown = false;
    this.saveTimer = 0;
    this.saveFailedShown = false;
    this.exported = false;
    this.lastTap = null;
    this.loadSeq = 0;

    const tool = lsGet('gereedschap', 'pen');
    this.tool = TOOLS.includes(tool) ? tool : 'pen';
    this.color = normHex(lsGet('kleur', DEFAULT_COLOR)) || DEFAULT_COLOR;
    const w = lsGet('dikte', DEFAULT_WIDTH);
    this.width = WIDTHS.some((x) => x.value === w) ? w : DEFAULT_WIDTH;
    const s = lsGet('tekst', DEFAULT_SIZE);
    this.fontSize = SIZES.some((x) => x.value === s) ? s : DEFAULT_SIZE;
    const custom = lsGet('eigenkleuren', []);
    this.customColors = Array.isArray(custom) ? custom.map(normHex).filter(Boolean).slice(0, 3) : [];

    this.els = {
      body: document.body,
      btn: $('btn-aantekenen'),
      bar: $('tekenbalk'),
      tools: [...document.querySelectorAll('#tekenbalk [data-tool]')],
      kleur: $('tk-kleur'),
      undo: $('tk-ongedaan'),
      redo: $('tk-opnieuw'),
      del: $('tk-verwijder'),
      klaar: $('tk-klaar'),
      panel: $('kleurpaneel'),
      swatches: $('kleur-stalen'),
      widths: $('dikte-keuze'),
      sizes: $('grootte-keuze'),
      eigen: $('eigen-kleur'),
      hint: $('tekenhint'),
      selbar: $('selectiebalk'),
      selDel: $('sel-verwijder'),
      selKleur: $('sel-kleur'),
      textbar: $('tekstbalk'),
      tbKleur: $('tb-kleur'),
      tbGrootte: $('tb-grootte'),
      tbGereed: $('tb-gereed'),
    };

    this.#buildPanel();
    this.#wire();
    this.#updateBar();
  }

  // ---------- Publieke API ----------

  get count() { return this.items.size; }
  get isActive() { return this.active; }
  get documentKey() { return this.key; }

  /** Alle aantekeningen, gesorteerd op pagina en volgorde van maken. */
  list() {
    return [...this.items.values()].sort((a, b) => a.page - b.page || a.created - b.created);
  }

  setEnabled(enabled) {
    setDisabled(this.els.btn, !enabled);
    if (!enabled && this.active) this.exit();
  }

  toggle() {
    if (this.active) this.exit(); else this.enter();
  }

  enter() {
    if (this.active || !this.viewer.isOpen) return;
    this.active = true;
    this.viewer.doubleTapZoom = false;
    document.body.classList.add('tekenmodus');
    this.els.bar.hidden = false;
    this.scrollEl.setAttribute('aria-label', 'Document, tekenmodus. Kies Selecteren om aantekeningen te bewerken.');
    this.#applyToolClass();
    this.#updateBar();
    this.#updateFocusable();
    announce('Tekenmodus aan');
    this.#showHint();
    const cur = this.els.tools.find((b) => b.dataset.tool === this.tool);
    if (cur) cur.focus({ preventScroll: true });
  }

  exit() {
    if (!this.active) return;
    this.commitText();
    this.#cancelGesture();
    this.#select(null);
    this.#closePanel();
    this.active = false;
    this.viewer.doubleTapZoom = true;
    this.spaceDown = false;
    document.body.classList.remove('tekenmodus', 'schuiven');
    for (const t of TOOLS) document.body.classList.remove(`tool-${t}`);
    this.els.bar.hidden = true;
    this.els.hint.hidden = true;
    this.scrollEl.setAttribute('aria-label', 'Document');
    this.#updateFocusable();
    announce('Tekenmodus uit');
    if (this.items.size && !lsGet('klaarHint', false)) {
      lsSet('klaarHint', true);
      toast('Je aantekeningen staan erin. Kies Opslaan om ze te bewaren.', { duration: 4000 });
    }
    if (!this.els.btn.disabled) this.els.btn.focus({ preventScroll: true });
  }

  /** Sluit een open tekstvak af (bewaren). */
  commitText() {
    if (this.editing) this.#finishText(true);
  }

  /** Na geslaagd opslaan als PDF. */
  async markExported() {
    this.exported = true;
    try { await this.#flush(); await markExported(this.key); } catch { /* */ }
  }

  /** "Geschiedenis wissen": ook alle bewaarde aantekeningen (na bevestiging). */
  async clearStored() {
    await this.#flush().catch(() => {});
    const { docs, items } = await countAll();
    if (!items) return true;
    const ok = await this.confirm({
      title: 'Ook aantekeningen wissen?',
      text: `Er zijn ${items} ${items === 1 ? 'aantekening' : 'aantekeningen'} bewaard bij ${docs} ${docs === 1 ? 'document' : 'documenten'}. Die worden ook gewist. Dit kun je niet ongedaan maken.`,
      ok: 'Wissen',
    });
    if (!ok) return false;
    try { await clearAll(); } catch { /* */ }
    for (const id of [...this.items.keys()]) this.#setItem(id, null);
    this.history.clear();
    this.#updateBar();
    return true;
  }

  // ---------- Document ----------

  async onDocumentLoaded(pdf) {
    const seq = ++this.loadSeq;
    if (this.active) this.exit();
    const hadItems = this.items.size > 0 && !this.exported;
    await this.#flush().catch(() => {});
    if (seq !== this.loadSeq) return;
    this.pdf = pdf;
    const fps = (pdf && pdf.fingerprints) || [];
    this.key = fps[0] ? `${fps[0]}|${fps[1] || ''}` : null;
    this.items.clear();
    this.history.clear();
    this.selected = null;
    this.exported = false;
    this.saveFailedShown = false;
    for (const layer of this.layers.values()) layer.gItems.replaceChildren();
    let restored = [];
    try {
      restored = await loadAnnotations(this.key);
    } catch {
      restored = [];
    }
    if (seq !== this.loadSeq) return;
    for (const it of restored) if (it.page <= pdf.numPages) this.items.set(it.id, it);
    this.#renderAll();
    this.#updateBar();
    if (this.items.size) {
      const n = this.items.size;
      toast(`${n} ${n === 1 ? 'aantekening' : 'aantekeningen'} hersteld`, { duration: 4000 });
    } else if (hadItems) {
      toast('Aantekeningen blijven bewaard bij het vorige document.', { duration: 4000 });
    }
  }

  onDocumentClosed() {
    if (this.active) this.exit();
    this.#flush().catch(() => {});
    this.pdf = null;
    this.key = null;
    this.items.clear();
    this.layers.clear();
    this.history.clear();
    this.#updateBar();
  }

  async onPageRendered({ page, element }) {
    const div = element.querySelector('.annotatielaag');
    if (!div || !this.viewer.pdf) return;
    const existing = this.layers.get(page);
    if (existing && existing.div === div && existing.div.isConnected) {
      this.#updateSelectionUi();
      return;
    }
    const pdf = this.viewer.pdf;
    let w;
    let h;
    try {
      const vp = (await pdf.getPage(page)).getViewport({ scale: 1 });
      w = vp.width;
      h = vp.height;
    } catch { return; }
    if (pdf !== this.viewer.pdf || !div.isConnected) return;
    if (div.querySelector('svg.annot-svg')) return;
    const svg = svgEl('svg', {
      class: 'annot-svg', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'false',
    });
    const gItems = svgEl('g', { class: 'annot-items' });
    const gUi = svgEl('g', { class: 'annot-ui' });
    svg.append(gItems, gUi);
    div.append(svg);
    const layer = { num: page, div, svg, gItems, gUi, w, h, nodes: new Map() };
    this.layers.set(page, layer);
    div.addEventListener('pointerdown', (e) => this.#onDown(layer, e));
    div.addEventListener('pointermove', (e) => this.#onMove(layer, e));
    div.addEventListener('pointerup', (e) => this.#onUp(layer, e));
    div.addEventListener('pointercancel', (e) => this.#onCancel(layer, e));
    div.addEventListener('lostpointercapture', (e) => { if (this.gesture && this.gesture.pointerId === e.pointerId) this.#onUp(layer, e); });
    div.addEventListener('dblclick', (e) => this.#onDblClick(layer, e));
    for (const it of this.items.values()) if (it.page === page) this.#renderItem(it);
    this.#updateFocusable();
    this.#updateSelectionUi();
  }

  // ---------- Bedrading ----------

  #wire() {
    const e = this.els;
    e.btn.addEventListener('click', () => this.toggle());
    for (const b of e.tools) b.addEventListener('click', () => this.setTool(b.dataset.tool));
    e.klaar.addEventListener('click', () => this.exit());
    e.undo.addEventListener('click', () => this.undo());
    e.redo.addEventListener('click', () => this.redo());
    e.del.addEventListener('click', () => this.deleteSelected());
    e.selDel.addEventListener('click', () => this.deleteSelected());
    e.kleur.addEventListener('click', () => this.#togglePanel(e.kleur));
    e.selKleur.addEventListener('click', () => this.#togglePanel(e.selKleur));
    $('paneel-sluit').addEventListener('click', () => this.#closePanel(true));
    $('wis-pagina').addEventListener('click', () => this.#clearPage());
    $('wis-alles').addEventListener('click', () => this.#clearAllDoc());

    // Roving tabindex in de gereedschapsbalk.
    e.bar.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const btns = [...e.bar.querySelectorAll('button:not([disabled])')].filter((b) => b.offsetParent !== null);
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      btns[(i + (ev.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
    });

    // Tekst-minibalk: focus in het tekstvak houden.
    for (const b of [e.tbKleur, e.tbGrootte, e.tbGereed]) b.addEventListener('pointerdown', (ev) => ev.preventDefault());
    e.panel.addEventListener('pointerdown', (ev) => { if (this.editing && ev.target.closest('button')) ev.preventDefault(); });
    e.tbKleur.addEventListener('click', () => this.#togglePanel(e.tbKleur));
    e.tbGrootte.addEventListener('click', () => {
      const i = SIZES.findIndex((s) => s.value === this.fontSize);
      this.#setSize(SIZES[(i + 1) % SIZES.length].value);
    });
    e.tbGereed.addEventListener('click', () => this.#finishText(true));

    // Aantal vingers bijhouden (capture: vóór de laag-handlers).
    const track = (ev) => {
      if (ev.pointerType !== 'touch') return;
      if (ev.type === 'pointerdown') {
        this.touches.add(ev.pointerId);
        if (this.touches.size > 1) {
          this.gestureLock = true;
          this.#twoFingers();
        }
      } else {
        this.touches.delete(ev.pointerId);
        if (!this.touches.size) this.gestureLock = false;
      }
    };
    this.scrollEl.addEventListener('pointerdown', track, true);
    window.addEventListener('pointerup', track, true);
    window.addEventListener('pointercancel', track, true);
    this.scrollEl.addEventListener('touchstart', (ev) => {
      if (ev.touches.length > 1) { this.gestureLock = true; this.#twoFingers(); }
    }, { capture: true, passive: true });

    // Paneel sluiten bij tik buiten.
    document.addEventListener('pointerdown', (ev) => {
      if (e.panel.hidden) return;
      if (e.panel.contains(ev.target) || ev.target.closest('#tk-kleur, #sel-kleur, #tb-kleur')) return;
      if (this.editing && this.editing.ta === ev.target) return;
      this.#closePanel();
    });

    window.addEventListener('keydown', (ev) => this.#onKey(ev), true);
    window.addEventListener('keyup', (ev) => {
      if (ev.key === ' ' && this.spaceDown) {
        this.spaceDown = false;
        document.body.classList.remove('schuiven');
      }
    }, true);
    window.addEventListener('blur', () => { this.spaceDown = false; document.body.classList.remove('schuiven'); });

    // Selectie-UI meebewegen.
    this.scrollEl.addEventListener('scroll', () => this.#queueSelectionUi(), { passive: true });
    window.addEventListener('resize', () => this.#queueSelectionUi());
    if (window.visualViewport) {
      const vv = () => this.#placeTextbar();
      window.visualViewport.addEventListener('resize', vv);
      window.visualViewport.addEventListener('scroll', vv);
    }
    bus.on('zoom-changed', () => {
      this.#queueSelectionUi();
      if (this.editing) this.#layoutTextarea();
    });
    bus.on('page-rendered', (d) => this.onPageRendered(d));
  }

  // ---------- Gereedschap / instellingen ----------

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    this.commitText();
    this.tool = tool;
    lsSet('gereedschap', tool);
    if (tool !== 'select') this.#select(null);
    this.#applyToolClass();
    this.#updateBar();
    this.#updateFocusable();
    announce(`${TOOL_NAMES[tool]} gekozen`);
  }

  #applyToolClass() {
    for (const t of TOOLS) document.body.classList.toggle(`tool-${t}`, this.active && t === this.tool);
  }

  #setColor(hex) {
    const c = normHex(hex);
    if (!c) return;
    this.color = c;
    lsSet('kleur', c);
    if (this.editing) {
      this.editing.color = c;
      this.#layoutTextarea();
    } else if (this.selected) {
      this.#updateSelected({ color: c }, 'Kleur');
    }
    this.#updateBar();
    this.#syncPanel();
    announce(`Kleur ${colorName(c)}`);
  }

  #setWidth(w) {
    this.width = w;
    lsSet('dikte', w);
    const sel = this.selected && this.items.get(this.selected);
    if (sel && sel.type !== 'text') this.#updateSelected({ width: w }, 'Lijndikte');
    this.#updateBar();
    this.#syncPanel();
    announce(`Lijndikte ${WIDTHS.find((x) => x.value === w).name.toLowerCase()}`);
  }

  #setSize(s) {
    this.fontSize = s;
    lsSet('tekst', s);
    if (this.editing) {
      this.editing.fontSize = s;
      this.#layoutTextarea();
    } else {
      const sel = this.selected && this.items.get(this.selected);
      if (sel && sel.type === 'text') this.#updateSelected({ fontSize: s }, 'Tekstgrootte');
    }
    this.#syncPanel();
    announce(`Tekstgrootte ${SIZES.find((x) => x.value === s).name.toLowerCase()}`);
  }

  #updateBar() {
    const e = this.els;
    for (const b of e.tools) {
      const on = b.dataset.tool === this.tool;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    e.kleur.style.setProperty('--kleur', this.color);
    e.kleur.style.setProperty('--dikte', `${Math.max(2, this.width * 1.2)}px`);
    e.kleur.classList.toggle('is-wit', this.color === '#FFFFFF');
    e.tbKleur.style.setProperty('--kleur', this.color);
    e.tbKleur.classList.toggle('is-wit', this.color === '#FFFFFF');
    e.selKleur.style.setProperty('--kleur', this.color);
    setDisabled(e.undo, !this.history.canUndo);
    setDisabled(e.redo, !this.history.canRedo);
    setDisabled(e.del, !this.selected);
  }

  // ---------- Kleur- en diktepaneel ----------

  #buildPanel() {
    const e = this.els;
    const mk = (group, label, value, extra) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.value = String(value);
      const span = document.createElement('span');
      span.className = 'optie-label';
      span.textContent = label;
      extra(b);
      b.append(span);
      group.append(b);
      return b;
    };
    for (const c of PALETTE) {
      mk(e.swatches, c.name, c.hex, (b) => {
        b.className = 'staal';
        b.setAttribute('aria-label', c.name);
        const dot = document.createElement('span');
        dot.className = 'staal-rond';
        dot.style.setProperty('--kleur', c.hex);
        if (c.hex === '#FFFFFF') dot.classList.add('is-wit');
        if (c.hex === '#FFD600' || c.hex === '#FFFFFF') dot.classList.add('licht');
        b.append(dot);
      });
    }
    e.swatches.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-value]');
      if (b) this.#setColor(b.dataset.value);
    });
    for (const w of WIDTHS) {
      mk(e.widths, w.name, w.value, (b) => {
        b.className = 'dikte-optie';
        const line = document.createElement('span');
        line.className = 'dikte-voorbeeld';
        line.style.setProperty('--dikte', `${Math.max(2, w.value * 1.4)}px`);
        b.append(line);
      });
    }
    e.widths.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-value]');
      if (b) this.#setWidth(Number(b.dataset.value));
    });
    for (const s of SIZES) {
      mk(e.sizes, s.name, s.value, (b) => {
        b.className = 'grootte-optie';
        const a = document.createElement('span');
        a.className = 'grootte-voorbeeld';
        a.textContent = 'A';
        a.style.setProperty('--grootte', `${s.value + 4}px`);
        b.append(a);
      });
    }
    e.sizes.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-value]');
      if (b) this.#setSize(Number(b.dataset.value));
    });
    // Eigen kleur (native kiezer) + laatste 3 eigen kleuren.
    e.eigen.addEventListener('change', () => {
      const c = normHex(e.eigen.value);
      if (!c) return;
      this.customColors = [c, ...this.customColors.filter((x) => x !== c)].slice(0, 3);
      lsSet('eigenkleuren', this.customColors);
      this.#renderCustom();
      this.#setColor(c);
    });
    $('eigen-recent').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-value]');
      if (b) this.#setColor(b.dataset.value);
    });
    this.#renderCustom();
    // Pijltjestoetsen binnen een radiogroep.
    for (const g of [e.swatches, e.widths, e.sizes]) {
      g.addEventListener('keydown', (ev) => {
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (!keys.includes(ev.key)) return;
        const bs = [...g.querySelectorAll('button')];
        const i = bs.indexOf(document.activeElement);
        if (i < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const next = bs[(i + (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length];
        next.focus();
        next.click();
      });
    }
    e.panel.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.#closePanel(true); }
    });
  }

  #renderCustom() {
    const box = $('eigen-recent');
    box.replaceChildren();
    for (const c of this.customColors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'staal staal-klein';
      b.setAttribute('role', 'radio');
      b.dataset.value = c;
      b.setAttribute('aria-label', `Eigen kleur ${c}`);
      b.title = c;
      const dot = document.createElement('span');
      dot.className = 'staal-rond';
      dot.style.setProperty('--kleur', c);
      b.append(dot);
      box.append(b);
    }
    this.#syncPanel();
  }

  #syncPanel() {
    const e = this.els;
    const set = (group, val) => {
      const bs = [...group.querySelectorAll('button[data-value]')];
      for (const b of bs) {
        const on = b.dataset.value === String(val);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (!bs.some((b) => b.tabIndex === 0) && bs[0]) bs[0].tabIndex = 0;
    };
    set(e.swatches, this.color);
    set($('eigen-recent'), this.color);
    set(e.widths, this.width);
    set(e.sizes, this.fontSize);
    for (const b of e.widths.querySelectorAll('.dikte-voorbeeld')) b.style.setProperty('--kleur', this.color);
    if (normHex(e.eigen.value) !== this.color) e.eigen.value = this.color.toLowerCase();
  }

  #togglePanel(opener) {
    if (!this.els.panel.hidden) { this.#closePanel(); return; }
    this.#openPanel(opener);
  }

  #openPanel(opener) {
    const p = this.els.panel;
    this.#syncPanel();
    p.hidden = false;
    this.panelOpener = opener;
    for (const b of [this.els.kleur, this.els.tbKleur, this.els.selKleur]) b.setAttribute('aria-expanded', String(b === opener));
    const mobile = matchMedia('(max-width: 719.98px)').matches;
    if (mobile) {
      p.style.left = '';
      p.style.top = '';
      p.classList.add('sheet');
      p.style.bottom = this.editing ? `${this.#keyboardInset() + 56}px` : '';
    } else {
      p.classList.remove('sheet');
      const r = opener.getBoundingClientRect();
      const w = p.offsetWidth;
      p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
      p.style.top = `${r.bottom + 8}px`;
      p.style.bottom = '';
    }
    if (!this.editing) {
      const cur = p.querySelector('#kleur-stalen [aria-checked="true"]') || p.querySelector('#kleur-stalen button');
      if (cur) cur.focus({ preventScroll: true });
    }
  }

  #closePanel(returnFocus = false) {
    if (this.els.panel.hidden) return false;
    this.els.panel.hidden = true;
    for (const b of [this.els.kleur, this.els.tbKleur, this.els.selKleur]) b.setAttribute('aria-expanded', 'false');
    if (this.editing) this.editing.ta.focus({ preventScroll: true });
    else if (returnFocus && this.panelOpener && this.panelOpener.offsetParent) this.panelOpener.focus({ preventScroll: true });
    return true;
  }

  // ---------- Items: tonen ----------

  #renderAll() {
    for (const layer of this.layers.values()) {
      layer.gItems.replaceChildren();
      layer.nodes.clear();
    }
    for (const it of this.list()) this.#renderItem(it);
    this.#updateFocusable();
    this.#updateSelectionUi();
  }

  #renderItem(item) {
    const layer = this.layers.get(item.page);
    if (!layer) return;
    let g = layer.nodes.get(item.id);
    if (!g) {
      g = svgEl('g', { class: 'annot-item', 'data-id': item.id, role: 'button' });
      g.addEventListener('focus', () => {
        if (this.active && this.tool === 'select' && this.selected !== item.id) this.#select(item.id);
      });
      layer.nodes.set(item.id, g);
      layer.gItems.append(g);
    }
    g.setAttribute('aria-label', describe(item));
    g.setAttribute('tabindex', this.active && this.tool === 'select' ? '0' : '-1');
    g.replaceChildren(this.#shapeNode(item));
  }

  #shapeNode(item) {
    if (item.type === 'text') {
      const lay = textLayout(item);
      const t = svgEl('text', {
        x: item.x + 1, y: item.y + lay.size, 'font-size': lay.size, fill: item.color, class: 'annot-tekst',
      });
      lay.lines.forEach((line, i) => {
        const span = svgEl('tspan', { x: item.x + 1, dy: i ? lay.lineH : 0 });
        span.textContent = line || '​';
        t.append(span);
      });
      return t;
    }
    const st = strokeStyle(item);
    return svgEl('path', {
      d: svgPath(item), fill: 'none', stroke: st.color, 'stroke-width': st.width, 'stroke-opacity': st.opacity,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'annot-vorm',
    });
  }

  #removeNode(id, page) {
    const layer = this.layers.get(page);
    if (!layer) return;
    const g = layer.nodes.get(id);
    if (g) { g.remove(); layer.nodes.delete(id); }
  }

  #updateFocusable() {
    const on = this.active && this.tool === 'select';
    for (const layer of this.layers.values()) {
      for (const g of layer.nodes.values()) g.setAttribute('tabindex', on ? '0' : '-1');
    }
  }

  // ---------- Items: wijzigen (met ongedaan maken) ----------

  #setItem(id, item) {
    const old = this.items.get(id);
    if (old && (!item || old.page !== item.page)) this.#removeNode(id, old.page);
    if (item) {
      this.items.set(id, item);
      this.#renderItem(item);
    } else {
      this.items.delete(id);
      if (this.selected === id) this.#select(null);
    }
  }

  /** Voert wijzigingen uit en zet ze op de ongedaan-stack. changes = [[id, voor, na]]. */
  #commit(label, changes) {
    const real = changes.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b));
    if (!real.length) return;
    for (const [id, , after] of real) this.#setItem(id, after);
    this.history.push(label, real);
    this.exported = false;
    this.#afterChange();
  }

  #afterChange() {
    this.#updateBar();
    this.#updateSelectionUi();
    this.#scheduleSave();
    bus.emit('annotations-changed', { count: this.items.size });
  }

  undo() {
    this.commitText();
    const r = this.history.undo();
    if (!r) return;
    for (const [id, item] of r.apply) this.#setItem(id, item);
    this.exported = false;
    this.#afterChange();
    announce(`Ongedaan gemaakt: ${r.label.toLowerCase()}`);
  }

  redo() {
    this.commitText();
    const r = this.history.redo();
    if (!r) return;
    for (const [id, item] of r.apply) this.#setItem(id, item);
    this.exported = false;
    this.#afterChange();
    announce(`Opnieuw: ${r.label.toLowerCase()}`);
  }

  #add(item) {
    this.#commit(TYPE_NAMES[item.type], [[item.id, null, item]]);
  }

  #updateSelected(patch, label) {
    const cur = this.items.get(this.selected);
    if (!cur) return;
    const next = { ...cur, ...patch };
    if (next.type === 'text') next.maxW = this.#textMaxW(next, this.layers.get(next.page));
    this.#commit(label, [[cur.id, cur, next]]);
  }

  deleteSelected() {
    const cur = this.selected && this.items.get(this.selected);
    if (!cur) return;
    this.#commit(TYPE_NAMES[cur.type], [[cur.id, cur, null]]);
    announce('Aantekening verwijderd');
    toast('Aantekening verwijderd', { action: { label: 'Ongedaan maken', onClick: () => this.undo() } });
  }

  async #clearPage() {
    const page = this.viewer.current;
    const list = this.list().filter((i) => i.page === page);
    if (!list.length) { toast(`Er staan geen aantekeningen op pagina ${page}.`); return; }
    this.#closePanel();
    const ok = await this.confirm({
      title: 'Aantekeningen op deze pagina wissen?',
      text: `${list.length} ${list.length === 1 ? 'aantekening' : 'aantekeningen'} op pagina ${page} worden gewist. Met Ongedaan zet je ze terug.`,
      ok: 'Wissen',
    });
    if (!ok) return;
    this.#commit('Wissen', list.map((i) => [i.id, i, null]));
    announce(`Aantekeningen op pagina ${page} gewist`);
  }

  async #clearAllDoc() {
    const list = this.list();
    if (!list.length) { toast('Er zijn geen aantekeningen.'); return; }
    this.#closePanel();
    const ok = await this.confirm({
      title: 'Alle aantekeningen wissen?',
      text: `Alle ${list.length} ${list.length === 1 ? 'aantekening' : 'aantekeningen'} in dit document worden gewist. Met Ongedaan zet je ze terug.`,
      ok: 'Alles wissen',
    });
    if (!ok) return;
    this.#commit('Wissen', list.map((i) => [i.id, i, null]));
    announce('Alle aantekeningen gewist');
  }

  // ---------- Bewaren ----------

  #scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.#persist(); }, SAVE_DELAY);
  }

  async #persist() {
    this.saveTimer = 0;
    if (!this.key) return;
    try {
      await saveAnnotations(this.key, this.list(), { exported: this.exported });
    } catch {
      if (!this.saveFailedShown) {
        this.saveFailedShown = true;
        toast('Aantekeningen worden niet bewaard bij afsluiten – sla de PDF op.', { type: 'fout', duration: 8000 });
      }
    }
  }

  async #flush() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    await this.#persist();
  }

  // ---------- Selectie ----------

  #select(id) {
    if (this.selected === id) { this.#updateSelectionUi(); return; }
    this.selected = id;
    this.#updateBar();
    this.#updateSelectionUi();
    if (id) {
      const it = this.items.get(id);
      if (it) announce(`Geselecteerd: ${describe(it)}`);
    }
  }

  #queueSelectionUi() {
    if (this.selRaf) return;
    this.selRaf = requestAnimationFrame(() => { this.selRaf = 0; this.#updateSelectionUi(); });
  }

  #pxPerPt(layer) {
    const r = layer.svg.getBoundingClientRect();
    return r.width / layer.w || 1;
  }

  #handles(item) {
    if (item.type === 'line') return [['p1', item.x1, item.y1], ['p2', item.x2, item.y2]];
    if (item.type === 'rect' || item.type === 'oval') {
      const { x, y, w, h } = item;
      return [['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y], ['e', x + w, y + h / 2],
        ['se', x + w, y + h], ['s', x + w / 2, y + h], ['sw', x, y + h], ['w', x, y + h / 2]];
    }
    return [];
  }

  #updateSelectionUi() {
    for (const layer of this.layers.values()) layer.gUi.replaceChildren();
    const item = this.selected && this.items.get(this.selected);
    const layer = item && this.layers.get(item.page);
    for (const l of this.layers.values()) {
      for (const [id, g] of l.nodes) g.classList.toggle('is-geselecteerd', !!item && id === item.id);
    }
    if (!item || !layer || !this.active) {
      this.els.selbar.hidden = true;
      return;
    }
    const k = this.#pxPerPt(layer);
    const b = bbox(item);
    const pad = 8 / k;
    layer.gUi.append(svgEl('rect', {
      class: 'sel-kader', x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad,
      'vector-effect': 'non-scaling-stroke',
    }));
    const hs = 12 / k;
    for (const [name, x, y] of this.#handles(item)) {
      layer.gUi.append(svgEl('rect', {
        class: `greep greep-${name}`, x: x - hs / 2, y: y - hs / 2, width: hs, height: hs,
        'vector-effect': 'non-scaling-stroke', 'data-greep': name,
      }));
    }
    // Zwevende knop "Verwijderen" boven (of onder) het kader.
    const sr = layer.svg.getBoundingClientRect();
    const top = sr.top + (b.y - pad) * k;
    const bottom = sr.top + (b.y + b.h + pad) * k;
    const cx = sr.left + (b.x + b.w / 2) * k;
    const bar = this.els.selbar;
    bar.hidden = false;
    const lr = this.scrollEl.getBoundingClientRect();
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    let y = top - bh - 8;
    if (y < lr.top + 4) y = bottom + 8;
    if (y + bh > lr.bottom - 4) y = Math.max(lr.top + 4, Math.min(top + 8, lr.bottom - bh - 4));
    const x = Math.max(8, Math.min(window.innerWidth - bw - 8, cx - bw / 2));
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
    const offscreen = bottom < lr.top || top > lr.bottom;
    bar.classList.toggle('verborgen', offscreen);
  }

  // ---------- Aanwijzer ----------

  #pt(layer, e) {
    const r = layer.svg.getBoundingClientRect();
    return [(e.clientX - r.left) * layer.w / r.width, (e.clientY - r.top) * layer.h / r.height];
  }

  #hitItem(layer, x, y, tolPt) {
    let best = null;
    let bestD = Infinity;
    const list = this.list().filter((i) => i.page === layer.num);
    for (let i = list.length - 1; i >= 0; i--) {
      const d = distance(list[i], x, y);
      if (d <= tolPt && d < bestD - 0.01) { best = list[i]; bestD = d; }
    }
    return best;
  }

  #hitHandle(item, x, y, tolPt) {
    for (const [name, hx, hy] of this.#handles(item)) {
      if (Math.abs(x - hx) <= tolPt && Math.abs(y - hy) <= tolPt) return name;
    }
    return null;
  }

  #onDown(layer, e) {
    if (!this.active) return;
    if (this.editing) {
      // Tik buiten het tekstvak: afronden (het blur-event doet dat ook; hier expliciet).
      if (e.target === this.editing.ta) return;
      e.preventDefault();
      this.#finishText(true);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch' && (this.penDown || this.gestureLock || this.touches.size > 1)) return;
    if (this.gesture) return;
    this.#closePanel();
    const [x, y] = this.#pt(layer, e);
    const k = this.#pxPerPt(layer);
    const touch = e.pointerType === 'touch';
    if (e.pointerType === 'pen') this.penDown = true;

    if (this.spaceDown) {
      e.preventDefault();
      this.gesture = { kind: 'pan', layer, pointerId: e.pointerId, cx: e.clientX, cy: e.clientY };
      document.body.classList.add('schuiven-actief');
      layer.div.setPointerCapture(e.pointerId);
      return;
    }

    const base = { layer, pointerId: e.pointerId, x0: x, y0: y, t0: performance.now(), moved: false, touch };
    const tol = (touch ? 22 : 12) / k;

    if (this.tool === 'select') {
      e.preventDefault();
      const sel = this.selected && this.items.get(this.selected);
      if (sel && sel.page === layer.num) {
        const h = this.#hitHandle(sel, x, y, (touch ? 24 : 10) / k);
        if (h) {
          this.gesture = { ...base, kind: 'resize', handle: h, before: sel };
          layer.div.setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = (sel && sel.page === layer.num && distance(sel, x, y) <= tol + 8 / k) ? sel : this.#hitItem(layer, x, y, tol);
      if (hit) {
        const wasSelected = this.selected === hit.id;
        this.#select(hit.id);
        this.gesture = { ...base, kind: 'move', before: hit, wasSelected };
        layer.div.setPointerCapture(e.pointerId);
      } else {
        this.#select(null);
      }
      return;
    }

    if (this.tool === 'text') {
      e.preventDefault();
      this.gesture = { ...base, kind: 'text-tap' };
      layer.div.setPointerCapture(e.pointerId);
      return;
    }

    e.preventDefault();
    const st = strokeStyle({ type: this.tool, color: this.color, width: this.width });
    const preview = svgEl('path', {
      fill: 'none', stroke: st.color, 'stroke-width': st.width, 'stroke-opacity': st.opacity,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'annot-voorbeeld',
    });
    layer.gUi.append(preview);
    this.gesture = { ...base, kind: this.tool, preview, points: [x, y], d: `M${x.toFixed(2)} ${y.toFixed(2)}` };
    if (this.tool === 'pen') preview.setAttribute('d', `${this.gesture.d}l0.01 0`);
    layer.div.setPointerCapture(e.pointerId);
  }

  #onMove(layer, e) {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId || g.layer !== layer) return;
    if (g.kind === 'pan') {
      this.scrollEl.scrollLeft -= e.clientX - g.cx;
      this.scrollEl.scrollTop -= e.clientY - g.cy;
      g.cx = e.clientX;
      g.cy = e.clientY;
      return;
    }
    const [x, y] = this.#pt(layer, e);
    const k = this.#pxPerPt(layer);
    if (!g.moved && Math.hypot(x - g.x0, y - g.y0) * k > (g.touch ? 6 : 3)) g.moved = true;
    const cx = clampPt(x, 0, layer.w);
    const cy = clampPt(y, 0, layer.h);

    switch (g.kind) {
      case 'pen': {
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const list = evs.length ? evs : [e];
        for (const ev of list) {
          const [px, py] = this.#pt(layer, ev);
          const qx = clampPt(px, 0, layer.w);
          const qy = clampPt(py, 0, layer.h);
          const n = g.points.length;
          if (Math.hypot(qx - g.points[n - 2], qy - g.points[n - 1]) * k < 1) continue;
          g.points.push(qx, qy);
          g.d += `L${qx.toFixed(2)} ${qy.toFixed(2)}`;
        }
        g.preview.setAttribute('d', g.d);
        break;
      }
      case 'line': {
        let [ex, ey] = [cx, cy];
        if (e.shiftKey) [ex, ey] = snap45(g.x0, g.y0, cx, cy);
        g.end = [clampPt(ex, 0, layer.w), clampPt(ey, 0, layer.h)];
        g.preview.setAttribute('d', `M${g.x0} ${g.y0}L${g.end[0]} ${g.end[1]}`);
        break;
      }
      case 'rect':
      case 'oval': {
        const box = boxFrom(g.x0, g.y0, cx, cy, e.shiftKey);
        g.box = box;
        g.preview.setAttribute('d', svgPath({ type: g.kind, ...box }));
        break;
      }
      case 'move': {
        if (!g.moved) return;
        const [dx, dy] = clampDelta(g.before, x - g.x0, y - g.y0, layer.w, layer.h);
        const next = translate(g.before, dx, dy);
        g.current = next;
        this.items.set(next.id, next);
        this.#renderItem(next);
        this.#updateSelectionUi();
        break;
      }
      case 'resize': {
        const next = resize(g.before, g.handle, cx, cy, { keepRatio: e.shiftKey });
        g.current = next;
        this.items.set(next.id, next);
        this.#renderItem(next);
        this.#updateSelectionUi();
        break;
      }
      default:
    }
  }

  #onUp(layer, e) {
    const g = this.gesture;
    if (e.pointerType === 'pen') this.penDown = false;
    if (!g || g.pointerId !== e.pointerId || g.layer !== layer) return;
    this.gesture = null;
    try { layer.div.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (g.preview) g.preview.remove();
    document.body.classList.remove('schuiven-actief');
    const common = { page: layer.num, color: this.color, created: Date.now() };

    switch (g.kind) {
      case 'pen': {
        const pts = g.points.length > 2 ? simplify(g.points, 0.5) : g.points.slice(0, 2);
        this.#add({ id: newId(), type: 'pen', width: this.width, points: pts.map((v) => Math.round(v * 100) / 100), ...common });
        break;
      }
      case 'line': {
        if (!g.end) break;
        const [x2, y2] = g.end;
        if (Math.hypot(x2 - g.x0, y2 - g.y0) < MIN_LINE) break;
        this.#add({ id: newId(), type: 'line', width: this.width, x1: g.x0, y1: g.y0, x2, y2, ...common });
        break;
      }
      case 'rect':
      case 'oval': {
        if (!g.box || g.box.w < MIN_SHAPE || g.box.h < MIN_SHAPE) break;
        this.#add({ id: newId(), type: g.kind, width: this.width, ...g.box, ...common });
        break;
      }
      case 'move': {
        if (g.current) {
          this.items.set(g.before.id, g.before);
          this.#commit('Verplaatsen', [[g.before.id, g.before, g.current]]);
        } else if (!g.moved && g.wasSelected && g.before.type === 'text') {
          this.#editText(layer, g.before);
        }
        break;
      }
      case 'resize': {
        if (g.current) {
          this.items.set(g.before.id, g.before);
          this.#commit('Formaat', [[g.before.id, g.before, g.current]]);
        }
        break;
      }
      case 'text-tap': {
        if (g.moved) break;
        const hit = this.#hitItem(layer, g.x0, g.y0, (g.touch ? 16 : 6) / this.#pxPerPt(layer));
        if (hit && hit.type === 'text') this.#editText(layer, hit);
        else this.#newText(layer, g.x0, g.y0 - this.fontSize * 0.7);
        break;
      }
      default:
    }
  }

  #onCancel(layer, e) {
    if (e.pointerType === 'pen') this.penDown = false;
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    this.#cancelGesture();
  }

  #cancelGesture() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.preview) g.preview.remove();
    if ((g.kind === 'move' || g.kind === 'resize') && g.current) {
      this.items.set(g.before.id, g.before);
      this.#renderItem(g.before);
      this.#updateSelectionUi();
    }
    try { g.layer.div.releasePointerCapture(g.pointerId); } catch { /* */ }
    document.body.classList.remove('schuiven-actief');
  }

  /** Tweede vinger: lopende streek annuleren, de viewer neemt scrollen/zoomen over. */
  #twoFingers() {
    const g = this.gesture;
    if (!g || !g.touch) return;
    this.#cancelGesture();
  }

  #onDblClick(layer, e) {
    if (!this.active || this.tool !== 'select' || this.editing) return;
    const [x, y] = this.#pt(layer, e);
    const hit = this.#hitItem(layer, x, y, 12 / this.#pxPerPt(layer));
    if (hit && hit.type === 'text') this.#editText(layer, hit);
  }

  // ---------- Tekst ----------

  #textMaxW(item, layer) {
    const pw = layer ? layer.w : 10000;
    return Math.max(item.fontSize || this.fontSize, pw - item.x - 2);
  }

  #newText(layer, x, y) {
    const fs = this.fontSize;
    const tx = clampPt(x, 0, Math.max(0, layer.w - fs * 2));
    const ty = clampPt(y, 0, Math.max(0, layer.h - fs * 1.4));
    this.#openEditor(layer, { id: newId(), type: 'text', page: layer.num, x: tx, y: ty, text: '', fontSize: fs, color: this.color, created: Date.now() }, null);
  }

  #editText(layer, item) {
    this.#select(null);
    this.color = item.color;
    this.fontSize = item.fontSize;
    this.#updateBar();
    this.#openEditor(layer, { ...item }, item);
  }

  #openEditor(layer, draft, original) {
    const ta = document.createElement('textarea');
    ta.className = 'annot-invoer';
    ta.setAttribute('aria-label', 'Tekst van de aantekening');
    ta.placeholder = 'Typ je aantekening';
    ta.maxLength = MAX_TEXT;
    ta.rows = 1;
    ta.value = draft.text;
    ta.spellcheck = true;
    this.editing = { layer, ta, id: draft.id, original, x: draft.x, y: draft.y, color: draft.color, fontSize: draft.fontSize, created: draft.created };
    if (original) {
      const g = layer.nodes.get(original.id);
      if (g) g.classList.add('wordt-bewerkt');
    }
    layer.div.append(ta);
    ta.addEventListener('input', () => this.#layoutTextarea());
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.#finishText(false); }
      else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); this.#finishText(true); }
    });
    ta.addEventListener('focusout', (ev) => {
      const to = ev.relatedTarget;
      if (to && (this.els.textbar.contains(to) || this.els.panel.contains(to))) return;
      // Even wachten: een tik op de minibalk of het paneel houdt de focus vast.
      setTimeout(() => {
        if (this.editing && this.editing.ta === ta && document.activeElement !== ta
          && !this.els.panel.contains(document.activeElement)) this.#finishText(true);
      }, 0);
    });
    this.#layoutTextarea();
    this.els.textbar.hidden = false;
    document.body.classList.add('tekst-bewerken');
    this.#placeTextbar();
    ta.focus({ preventScroll: true });
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
    requestAnimationFrame(() => ta.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  #layoutTextarea() {
    const ed = this.editing;
    if (!ed) return;
    const { ta, layer } = ed;
    const maxW = this.#textMaxW({ x: ed.x, fontSize: ed.fontSize }, layer);
    const lay = textLayout({ text: ta.value || 'Typ je aantekening', fontSize: ed.fontSize, maxW });
    const w = Math.min(maxW + 2, Math.max(lay.w + ed.fontSize, ed.fontSize * 4));
    ta.style.setProperty('--x', String(ed.x / layer.w * 100));
    ta.style.setProperty('--y', String(ed.y / layer.h * 100));
    ta.style.setProperty('--fs', String(ed.fontSize));
    ta.style.setProperty('--w', String(w));
    ta.style.setProperty('--regels', String(Math.max(1, lay.lines.length)));
    ta.style.setProperty('--kleur', ed.color);
    ta.classList.toggle('is-wit', ed.color === '#FFFFFF');
  }

  #keyboardInset() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
  }

  #placeTextbar() {
    const bar = this.els.textbar;
    if (bar.hidden) return;
    bar.style.bottom = `${this.#keyboardInset()}px`;
    if (this.editing) {
      const r = this.editing.ta.getBoundingClientRect();
      const vv = window.visualViewport;
      const visibleBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - bar.offsetHeight - 16;
      if (r.bottom > visibleBottom) this.scrollEl.scrollTop += r.bottom - visibleBottom;
    }
  }

  #finishText(keep) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const text = ed.ta.value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    ed.ta.remove();
    this.els.textbar.hidden = true;
    document.body.classList.remove('tekst-bewerken');
    if (ed.original) {
      const g = ed.layer.nodes.get(ed.original.id);
      if (g) g.classList.remove('wordt-bewerkt');
    }
    if (!keep) {
      if (ed.original) this.#renderItem(ed.original);
      return;
    }
    if (!text.trim()) {
      if (ed.original) this.#commit('Tekst', [[ed.id, ed.original, null]]);
      return;
    }
    const item = {
      id: ed.id, type: 'text', page: ed.layer.num, x: ed.x, y: ed.y, text, fontSize: ed.fontSize,
      color: ed.color, created: ed.created,
    };
    item.maxW = this.#textMaxW(item, ed.layer);
    // Binnen de pagina houden (ook de onderrand).
    const b = bbox(item);
    if (b.y + b.h > ed.layer.h) item.y = Math.max(0, ed.layer.h - b.h);
    this.#commit('Tekst', [[ed.id, ed.original || null, item]]);
  }

  // ---------- Toetsenbord ----------

  #onKey(e) {
    if (anyDialogOpen()) return;
    const tag = e.target && e.target.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (!this.active) {
      if (!mod && !e.altKey && !inField && k === 'a' && this.viewer.isOpen && !this.els.btn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        this.enter();
      }
      return;
    }

    // Ctrl/Cmd+S: eerst het tekstvak afronden, daarna gaat de app verder met opslaan.
    if (mod && k === 's') { this.commitText(); return; }
    if (inField) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };

    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) { stop(); this.undo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { stop(); this.redo(); return; }
      return;
    }
    if (e.altKey) return;
    if (e.key === 'Escape') {
      if (this.gesture) { stop(); this.#cancelGesture(); return; }
      if (this.selected) { stop(); this.#select(null); return; }
      if (this.#closePanel(true)) { stop(); return; }
      stop();
      this.exit();
      return;
    }
    const onBarButton = e.target && e.target.closest && e.target.closest('#tekenbalk, #kleurpaneel');
    if (e.key === ' ') {
      if (onBarButton) return;
      stop();
      if (!this.spaceDown) {
        this.spaceDown = true;
        document.body.classList.add('schuiven');
      }
      return;
    }
    if (TOOL_KEYS[k]) { stop(); this.setTool(TOOL_KEYS[k]); return; }
    if (k === 'k') { stop(); this.#openPanel(this.els.kleur); return; }
    if (k === '1' || k === '2' || k === '3') { stop(); this.#setWidth(WIDTHS[Number(k) - 1].value); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { stop(); this.deleteSelected(); return; }
    if (e.key === 'Enter' && !onBarButton) {
      const sel = this.selected && this.items.get(this.selected);
      if (sel && sel.type === 'text') { stop(); this.#editText(this.layers.get(sel.page), sel); return; }
      if (this.tool === 'text') {
        const layer = this.layers.get(this.viewer.current);
        if (layer) { stop(); this.#newText(layer, layer.w * 0.1, this.#visibleMidY(layer)); }
      }
      return;
    }
    if (this.selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !onBarButton) {
      stop();
      const step = e.shiftKey ? 10 : 1;
      const cur = this.items.get(this.selected);
      const layer = this.layers.get(cur.page);
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      if (layer) [dx, dy] = clampDelta(cur, dx, dy, layer.w, layer.h);
      this.#commit('Verplaatsen', [[cur.id, cur, translate(cur, dx, dy)]]);
    }
  }

  #visibleMidY(layer) {
    const r = layer.svg.getBoundingClientRect();
    const lr = this.scrollEl.getBoundingClientRect();
    const mid = (Math.max(r.top, lr.top) + Math.min(r.bottom, lr.bottom)) / 2;
    return clampPt((mid - r.top) * layer.h / r.height, 0, layer.h - 20);
  }

  // ---------- Hint ----------

  #showHint() {
    let shown = false;
    try { shown = sessionStorage.getItem('pdfreader.annot.hint') === '1'; } catch { /* */ }
    if (shown) return;
    try { sessionStorage.setItem('pdfreader.annot.hint', '1'); } catch { /* */ }
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.els.hint.textContent = coarse
      ? 'Teken met 1 vinger. Scroll en zoom met 2 vingers.'
      : 'Teken met de muis. Houd spatie ingedrukt om te schuiven.';
    this.els.hint.hidden = false;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => { this.els.hint.hidden = true; }, 4000);
  }
}


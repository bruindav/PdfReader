// fix-1
// Module "viewer": pagina's tonen, lazy renderen, zoomen (knoppen, wiel, pinch) en navigeren.
//
// Lagen per pagina (absoluut gestapeld in <section class="pagina">):
//   1. canvas        – pdf.js-rendering (scale × devicePixelRatio, begrensd)
//   2. .textLayer    – pdf.js TextLayer (selecteerbare tekst, schermlezer)
//   3. .linklaag     – klikbare links
//   4. .annotatielaag – leeg; gereserveerd voor fase 2 (eigen SVG in PDF-coördinaten)
//
// Paginamaten zijn CSS-berekeningen met --total-scale-factor, zodat een zoomwijziging
// één CSS-variabele aanpast. Canvassen worden daarna (gedebounced) scherp herrenderd.
import { bus } from './eventbus.js';
import { pdfjsLib } from './loader.js';

const CSS_UNITS = 96 / 72;
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
const FIT_MIN = 0.1; // passend-modi mogen onder 50% (smalle telefoons)
const PADDING = 12; // moet overeenkomen met .paginas padding in CSS
const KEEP_RANGE = 2; // pagina's rond het zichtbare deel die gerenderd blijven
const RERENDER_DELAY = 250;

// Begrens canvasgrootte (Safari/iOS heeft een limiet op canvasgeheugen).
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const MAX_CANVAS_PIXELS = COARSE ? 5242880 : 16777216;

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Viewer {
  /**
   * @param {HTMLElement} scrollEl  scrollend leesgebied (<main>)
   * @param {HTMLElement} pagesEl   container voor de pagina's
   */
  constructor(scrollEl, pagesEl) {
    this.scrollEl = scrollEl;
    this.pagesEl = pagesEl;
    this.pdf = null;
    this.pages = [];
    this.mode = 'width';
    this.scale = 1;
    this.current = 1;
    this.visible = new Set();
    this.token = 0;
    this.renderTimer = 0;
    this.rendering = false;
    this.renderAgain = false;
    this.scrollRaf = 0;
    this.pinch = null;
    this.lastTap = null;

    this.io = null;
    this.ro = new ResizeObserver(() => this.#onResize());
    this.ro.observe(scrollEl);

    scrollEl.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    scrollEl.addEventListener('wheel', (e) => this.#onWheel(e), { passive: false });
    scrollEl.addEventListener('touchstart', (e) => this.#onTouchStart(e), { passive: false });
    scrollEl.addEventListener('touchmove', (e) => this.#onTouchMove(e), { passive: false });
    scrollEl.addEventListener('touchend', (e) => this.#onTouchEnd(e), { passive: false });
    scrollEl.addEventListener('touchcancel', (e) => this.#onTouchEnd(e), { passive: false });
    // Safari (iOS/macOS): eigen paginazoom in het leesgebied voorkomen.
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      scrollEl.addEventListener(t, (e) => { if (this.pdf) e.preventDefault(); }, { passive: false });
    }
  }

  get pageCount() { return this.pages.length; }
  get isOpen() { return !!this.pdf; }
  get canZoomIn() { return this.isOpen && this.scale < ZOOM_MAX - 1e-6; }
  get canZoomOut() { return this.isOpen && this.scale > ZOOM_MIN + 1e-6; }

  /** Opent een geladen pdf.js-document. */
  async open(pdf, { page = 1, zoom = 'width' } = {}) {
    this.close();
    const token = ++this.token;
    this.pdf = pdf;

    const first = await pdf.getPage(1);
    if (token !== this.token) return;
    const vp1 = first.getViewport({ scale: 1 });
    const n = pdf.numPages;

    const frag = document.createDocumentFragment();
    this.pages = [];
    for (let i = 1; i <= n; i++) {
      const el = document.createElement('section');
      el.className = 'pagina';
      el.setAttribute('aria-label', `Pagina ${i} van ${n}`);
      el.dataset.page = String(i);
      const ph = document.createElement('div');
      ph.className = 'pagina-placeholder';
      ph.textContent = `Pagina ${i} wordt geladen…`;
      el.append(ph);
      const p = {
        num: i, el, placeholder: ph, pw: vp1.width, ph: vp1.height,
        canvas: null, renderedScale: 0, task: null, textLayer: null, textDiv: null, linksDone: false,
      };
      this.#setDims(p, vp1.width, vp1.height);
      this.pages.push(p);
      frag.append(el);
    }
    this.pagesEl.replaceChildren(frag);
    this.pagesEl.hidden = false;

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const num = Number(e.target.dataset.page);
        if (e.isIntersecting) this.visible.add(num); else this.visible.delete(num);
      }
      this.#scheduleRender(0);
    }, { root: this.scrollEl, rootMargin: '100% 50%', threshold: 0 });
    for (const p of this.pages) this.io.observe(p.el);

    this.mode = zoom;
    this.#applyScale(this.#resolve(zoom));
    this.current = 0;
    this.goToPage(clamp(page, 1, n));
    bus.emit('zoom-changed', { mode: this.mode, scale: this.scale });
    this.#scheduleRender(0);

    this.#fetchDimensions(token);
  }

  close() {
    this.token++;
    clearTimeout(this.renderTimer);
    if (this.io) { this.io.disconnect(); this.io = null; }
    for (const p of this.pages) this.#freePage(p);
    this.pages = [];
    this.visible.clear();
    this.pagesEl.replaceChildren();
    this.pagesEl.hidden = true;
    if (this.pdf) {
      this.pdf.destroy();
      this.pdf = null;
    }
    this.current = 1;
  }

  // ---------- Navigatie ----------

  goToPage(n) {
    const p = this.pages[n - 1];
    if (!p) return;
    this.scrollEl.scrollTop = p.el.offsetTop - PADDING;
    this.#updateCurrent(n);
  }

  nextPage(delta = 1) {
    this.goToPage(clamp(this.current + delta, 1, this.pageCount));
  }

  // ---------- Zoom ----------

  /**
   * @param {'width'|'page'|'auto'|number} mode
   * @param {{x:number,y:number}|null} anchor punt (t.o.v. leesgebied) dat op zijn plek blijft
   * @param {{live?:boolean}} opts live = tijdens pinch/wiel: geen voorkeur opslaan
   */
  setZoom(mode, anchor = null, { live = false } = {}) {
    if (!this.isOpen) return;
    const scale = this.#resolve(mode);
    const a = anchor || { x: this.scrollEl.clientWidth / 2, y: this.scrollEl.clientHeight / 2 };
    const pos = this.#capture(a);
    this.mode = mode;
    this.#applyScale(scale);
    this.#restore(pos, a);
    bus.emit('zoom-changed', { mode: this.mode, scale: this.scale, live });
    this.#scheduleRender(RERENDER_DELAY);
  }

  zoomIn(anchor) {
    const next = ZOOM_STEPS.find((s) => s > this.scale + 0.005);
    if (next) this.setZoom(next, anchor);
  }

  zoomOut(anchor) {
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < this.scale - 0.005);
    if (prev) this.setZoom(prev, anchor);
  }

  #resolve(mode) {
    const ref = this.pages[(this.current || 1) - 1] || this.pages[0];
    if (!ref) return 1;
    const availW = Math.max(50, this.scrollEl.clientWidth - 2 * PADDING);
    const availH = Math.max(50, this.scrollEl.clientHeight - 2 * PADDING);
    const fitW = availW / (ref.pw * CSS_UNITS);
    const fitP = Math.min(fitW, availH / (ref.ph * CSS_UNITS));
    if (mode === 'width') return clamp(fitW, FIT_MIN, ZOOM_MAX);
    if (mode === 'page') return clamp(fitP, FIT_MIN, ZOOM_MAX);
    if (mode === 'auto') return clamp(Math.min(1, fitW), FIT_MIN, ZOOM_MAX);
    return clamp(Number(mode) || 1, Math.min(ZOOM_MIN, this.scale), ZOOM_MAX);
  }

  #applyScale(scale) {
    this.scale = scale;
    this.pagesEl.style.setProperty('--total-scale-factor', String(scale * CSS_UNITS));
  }

  #setDims(p, w, h) {
    p.pw = w;
    p.ph = h;
    p.el.style.setProperty('--pw', String(w));
    p.el.style.setProperty('--ph', String(h));
  }

  /** Zoekt de pagina onder een punt en bewaart de relatieve positie daarin. */
  #capture(a) {
    const y = this.scrollEl.scrollTop + a.y;
    const x = this.scrollEl.scrollLeft + a.x;
    const i = this.#indexAt(y);
    const el = this.pages[i].el;
    return {
      i,
      fx: (x - el.offsetLeft) / el.offsetWidth,
      fy: (y - el.offsetTop) / el.offsetHeight,
    };
  }

  #restore(pos, a) {
    const el = this.pages[pos.i].el;
    this.scrollEl.scrollTop = el.offsetTop + pos.fy * el.offsetHeight - a.y;
    this.scrollEl.scrollLeft = el.offsetLeft + pos.fx * el.offsetWidth - a.x;
  }

  /** Binair zoeken: index van de pagina die y (contentcoördinaat) bevat of erna komt. */
  #indexAt(y) {
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const el = this.pages[mid].el;
      if (el.offsetTop + el.offsetHeight + PADDING <= y) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  #onResize() {
    if (!this.isOpen) return;
    if (typeof this.mode === 'string') this.setZoom(this.mode, null, { live: true });
  }

  #onScroll() {
    if (this.scrollRaf || !this.isOpen) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (!this.isOpen) return;
      const top = this.scrollEl.scrollTop;
      const bottom = top + this.scrollEl.clientHeight;
      const start = this.#indexAt(top);
      let best = start;
      let bestH = -1;
      for (let i = start; i < Math.min(this.pages.length, start + 4); i++) {
        const el = this.pages[i].el;
        const h = Math.min(bottom, el.offsetTop + el.offsetHeight) - Math.max(top, el.offsetTop);
        if (h > bestH) { bestH = h; best = i; }
      }
      this.#updateCurrent(best + 1);
    });
  }

  #updateCurrent(n) {
    if (n === this.current) return;
    this.current = n;
    bus.emit('page-changed', { page: n, count: this.pageCount });
  }

  // ---------- Invoer: wiel en aanraking ----------

  #point(clientX, clientY) {
    const r = this.scrollEl.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  #onWheel(e) {
    if (!this.isOpen || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : 0.0025;
    const factor = Math.exp(-e.deltaY * unit);
    const target = clamp(this.scale * factor, Math.min(ZOOM_MIN, this.scale), ZOOM_MAX);
    this.setZoom(target, this.#point(e.clientX, e.clientY), { live: true });
    clearTimeout(this.wheelEnd);
    this.wheelEnd = setTimeout(() => bus.emit('zoom-changed', { mode: this.mode, scale: this.scale }), RERENDER_DELAY);
  }

  #onTouchStart(e) {
    if (!this.isOpen) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      this.pinch = {
        dist: Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1,
        scale: this.scale,
      };
      this.lastTap = null;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      this.tapStart = { x: t.clientX, y: t.clientY, time: performance.now() };
    }
  }

  #onTouchMove(e) {
    if (this.pinch && e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const d = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const target = clamp(this.pinch.scale * (d / this.pinch.dist), Math.min(ZOOM_MIN, this.pinch.scale), ZOOM_MAX);
      const mid = this.#point((t1.clientX + t2.clientX) / 2, (t1.clientY + t2.clientY) / 2);
      if (Math.abs(target - this.scale) > 0.002) this.setZoom(target, mid, { live: true });
    } else if (this.tapStart) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - this.tapStart.x, t.clientY - this.tapStart.y) > 10) this.tapStart = null;
    }
  }

  #onTouchEnd(e) {
    if (this.pinch) {
      if (e.touches.length < 2) {
        this.pinch = null;
        bus.emit('zoom-changed', { mode: this.mode, scale: this.scale });
      }
      this.tapStart = null;
      return;
    }
    // Dubbeltik: wisselen tussen Breedte en 200%.
    if (!this.isOpen || !this.tapStart || e.changedTouches.length !== 1 || e.touches.length) return;
    const t = e.changedTouches[0];
    const now = performance.now();
    if (now - this.tapStart.time > 300) { this.lastTap = null; return; }
    const tap = { x: t.clientX, y: t.clientY, time: now };
    const prev = this.lastTap;
    if (prev && now - prev.time < 320 && Math.hypot(tap.x - prev.x, tap.y - prev.y) < 30) {
      e.preventDefault();
      this.lastTap = null;
      const pt = this.#point(tap.x, tap.y);
      this.setZoom(this.mode === 'width' ? 2 : 'width', pt);
    } else {
      this.lastTap = tap;
    }
    this.tapStart = null;
  }

  // ---------- Renderen ----------

  #scheduleRender(delay) {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.#renderLoop(), delay);
  }

  async #renderLoop() {
    if (this.rendering) { this.renderAgain = true; return; }
    this.rendering = true;
    const token = this.token;
    try {
      do {
        this.renderAgain = false;
        const cur = this.current || 1;
        const targets = [...this.visible].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
        for (const num of targets) {
          if (token !== this.token || this.renderAgain) break;
          const p = this.pages[num - 1];
          if (p) await this.#renderPage(p, token);
        }
        if (token !== this.token) break;
        this.#freeFarPages();
      } while (this.renderAgain && token === this.token);
    } finally {
      this.rendering = false;
    }
  }

  async #renderPage(p, token) {
    const scale = this.scale * CSS_UNITS;
    if (p.canvas && Math.abs(p.renderedScale - scale) < 1e-6) return;
    let page;
    try {
      page = await this.pdf.getPage(p.num);
    } catch {
      return;
    }
    if (token !== this.token) return;

    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    let out = dpr;
    if (vp.width * vp.height * out * out > MAX_CANVAS_PIXELS) {
      out = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width * out));
    canvas.height = Math.max(1, Math.floor(vp.height * out));
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d', { alpha: false });
    const sx = canvas.width / vp.width;
    const sy = canvas.height / vp.height;

    if (p.task) p.task.cancel();
    const task = page.render({
      canvasContext: ctx,
      canvas,
      viewport: vp,
      transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : null,
      background: '#FFFFFF',
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    });
    p.task = task;
    try {
      await task.promise;
    } catch (e) {
      canvas.width = canvas.height = 0;
      if (e && e.name === 'RenderingCancelledException') return;
      if (p.task === task) p.task = null;
      return;
    }
    if (p.task === task) p.task = null;
    if (token !== this.token) { canvas.width = canvas.height = 0; return; }

    // Nieuw canvas pas plaatsen als het klaar is (geen flits).
    if (p.canvas) {
      p.canvas.replaceWith(canvas);
      p.canvas.width = p.canvas.height = 0;
    } else {
      p.el.prepend(canvas);
    }
    p.canvas = canvas;
    p.renderedScale = scale;
    if (p.placeholder) { p.placeholder.remove(); p.placeholder = null; }

    await this.#renderTextLayer(p, page, vp, token);
    if (!p.linksDone) await this.#renderLinks(p, page, token);
    if (!p.el.querySelector('.annotatielaag')) {
      const ann = document.createElement('div');
      ann.className = 'annotatielaag';
      ann.dataset.page = String(p.num);
      p.el.append(ann);
    }
    bus.emit('page-rendered', { page: p.num, scale: this.scale, element: p.el });
  }

  async #renderTextLayer(p, page, vp, token) {
    try {
      if (p.textLayer) {
        p.textLayer.update({ viewport: vp });
        return;
      }
      const div = document.createElement('div');
      div.className = 'textLayer';
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: div,
        viewport: vp,
      });
      p.textLayer = tl;
      p.textDiv = div;
      if (p.canvas) p.canvas.after(div); else p.el.append(div);
      await tl.render();
      if (token !== this.token) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      div.append(end);
    } catch {
      /* tekstlaag is optioneel; canvas blijft zichtbaar */
    }
  }

  async #renderLinks(p, page, token) {
    p.linksDone = true;
    let annots;
    try {
      annots = await page.getAnnotations({ intent: 'display' });
    } catch {
      return;
    }
    if (token !== this.token) return;
    const vp1 = page.getViewport({ scale: 1 });
    const layer = document.createElement('div');
    layer.className = 'linklaag';
    for (const a of annots) {
      if (a.annotationType !== pdfjsLib.AnnotationType.LINK) continue;
      const [x1, y1, x2, y2] = vp1.convertToViewportRectangle(a.rect);
      const left = Math.min(x1, x2) / vp1.width * 100;
      const top = Math.min(y1, y2) / vp1.height * 100;
      const w = Math.abs(x2 - x1) / vp1.width * 100;
      const h = Math.abs(y2 - y1) / vp1.height * 100;
      const link = document.createElement('a');
      link.style.left = `${left}%`;
      link.style.top = `${top}%`;
      link.style.width = `${w}%`;
      link.style.height = `${h}%`;
      if (a.url) {
        let url;
        try { url = new URL(a.url); } catch { continue; }
        if (!SAFE_PROTOCOLS.has(url.protocol)) continue;
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = url.href;
        link.setAttribute('aria-label', `Link: ${url.href}`);
      } else if (a.dest) {
        link.href = '#';
        link.setAttribute('aria-label', 'Link naar andere pagina');
        link.addEventListener('click', (ev) => {
          ev.preventDefault();
          this.#goToDest(a.dest);
        });
      } else {
        continue;
      }
      layer.append(link);
    }
    if (layer.childElementCount) p.el.append(layer);
  }

  async #goToDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const index = typeof ref === 'object' && ref !== null ? await this.pdf.getPageIndex(ref)
        : Number.isInteger(ref) ? ref : -1;
      if (index >= 0) this.goToPage(index + 1);
    } catch {
      /* ongeldige bestemming: negeren */
    }
  }

  /** Geeft canvassen van verre pagina's vrij (geheugen, vooral iOS). */
  #freeFarPages() {
    if (!this.visible.size) return;
    const nums = [...this.visible];
    const lo = Math.min(...nums) - KEEP_RANGE;
    const hi = Math.max(...nums) + KEEP_RANGE;
    for (const p of this.pages) {
      if ((p.canvas || p.textDiv) && (p.num < lo || p.num > hi)) this.#freePage(p, true);
    }
  }

  #freePage(p, keepPlaceholder = false) {
    if (p.task) { p.task.cancel(); p.task = null; }
    if (p.textLayer) { try { p.textLayer.cancel(); } catch { /* */ } p.textLayer = null; }
    if (p.textDiv) { p.textDiv.remove(); p.textDiv = null; }
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0;
      p.canvas.remove();
      p.canvas = null;
    }
    p.renderedScale = 0;
    if (keepPlaceholder && !p.placeholder) {
      const ph = document.createElement('div');
      ph.className = 'pagina-placeholder';
      ph.textContent = `Pagina ${p.num} wordt geladen…`;
      p.el.prepend(ph);
      p.placeholder = ph;
    }
  }

  /** Haalt op de achtergrond de echte afmetingen van alle pagina's op. */
  async #fetchDimensions(token) {
    for (let i = 2; i <= this.pages.length; i++) {
      if (token !== this.token) return;
      let page;
      try { page = await this.pdf.getPage(i); } catch { continue; }
      if (token !== this.token) return;
      const vp = page.getViewport({ scale: 1 });
      const p = this.pages[i - 1];
      if (Math.abs(vp.width - p.pw) > 0.5 || Math.abs(vp.height - p.ph) > 0.5) {
        const a = { x: this.scrollEl.clientWidth / 2, y: 0 };
        const pos = this.#capture(a);
        this.#setDims(p, vp.width, vp.height);
        this.#restore(pos, a);
      }
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
}

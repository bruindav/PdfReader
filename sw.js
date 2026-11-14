// fix-1
// fix-2: aantekeningen-modules en pdf-lib in de precache; fontkit + Noto Sans in de runtime-cache.
// PdfReader service worker: offline app-shell + ontvangst van gedeelde PDF's (share_target).
// Verhoog VERSION bij elke release, zodat gebruikers de melding "Nieuwe versie beschikbaar" krijgen.
const VERSION = 'fix-2';
const SHELL_CACHE = `pdfreader-shell-${VERSION}`;
const RUNTIME_CACHE = `pdfreader-runtime-${VERSION}`;
const SHARE_CACHE = 'pdfreader-share';

const PDFJS = 'vendor/pdfjs/';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/eventbus.js',
  'js/loader.js',
  'js/viewer.js',
  'js/save.js',
  'js/storage.js',
  'js/ui.js',
  'js/install.js',
  'js/nomodule.js',
  'js/annotations.js',
  'js/annot-model.js',
  'js/annot-store.js',
  'js/annot-export.js',
  // pdf-lib (lazy geladen bij opslaan met aantekeningen; vooraf gecachet zodat het ook offline werkt).
  'vendor/pdf-lib/pdf-lib.esm.min.js',
  'icons/icon.svg',
  'icons/favicon.svg',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  `${PDFJS}pdf.min.mjs`,
  `${PDFJS}pdf.worker.min.mjs`,
  `${PDFJS}iccs/CGATS001Compat-v2-micro.icc`,
  ...['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm']
    .map((f) => `${PDFJS}wasm/${f}`),
  ...['FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb',
    'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb',
    'LiberationSans-Bold.ttf', 'LiberationSans-BoldItalic.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-Regular.ttf']
    .map((f) => `${PDFJS}standard_fonts/${f}`),
  // cmaps (alleen nodig voor o.a. Aziatische lettertypen) worden bij eerste gebruik gecachet.
  // vendor/pdf-lib/fontkit.umd.min.js en vendor/fonts/NotoSans-Regular.ttf (alleen nodig voor tekst
  // buiten WinAnsi, bijv. Grieks/Cyrillisch) worden bij eerste gebruik gecachet.
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    // Bij de allereerste installatie direct actief worden; updates wachten op de gebruiker.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE, SHARE_CACHE]);
    for (const key of await caches.keys()) {
      if (key.startsWith('pdfreader-') && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const scopeUrl = () => new URL(self.registration.scope);

async function handleShare(request) {
  const target = new URL('./?shared=1', scopeUrl()).href;
  try {
    const form = await request.formData();
    let file = form.get('pdf');
    if (!(file instanceof File)) {
      file = [...form.values()].find((v) => v instanceof File) || null;
    }
    const cache = await caches.open(SHARE_CACHE);
    await cache.delete('shared-file');
    if (file) {
      await cache.put('shared-file', new Response(file, {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name || ''),
        },
      }));
    }
  } catch {
    /* App toont "Het gedeelde bestand is niet meer beschikbaar." */
  }
  return Response.redirect(target, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // geen externe verzoeken afhandelen

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('./') || await cache.match('index.html');
      if (cached) return cached;
      return fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && url.pathname.includes('/vendor/')) {
      const copy = response.clone();
      caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy)).catch(() => {});
    }
    return response;
  })());
});

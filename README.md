<!-- fix-1 -->
# PdfReader

Een rustige, reclamevrije PDF-lezer die in de browser draait: **https://bruindav.github.io/PdfReader/**

- Geen reclame, geen tracking, geen account. Je bestand blijft op je eigen toestel (er wordt niets geüpload).
- PDF openen via de knop, slepen (computer) of delen vanuit een andere app (Android, na installeren).
- Zoomen met knoppen, knijpen (twee vingers), Ctrl/Cmd + scrollwiel of Ctrl/Cmd + / − / 0. Tekst blijft scherp.
- Opslaan zonder beperking: je kiest zelf map en naam (waar de browser dat toestaat); anders via Delen of Downloads. Het bestand wordt byte-voor-byte ongewijzigd opgeslagen.
- Wachtwoordbeveiligde PDF's, ga naar pagina, onthoudt per document de laatste pagina en zoom (alleen een vingerafdruk, geen inhoud).
- Werkt offline na het eerste bezoek.

## Installeren als app

**iPhone / iPad (Safari)**
1. Open de site in Safari.
2. Tik onderin op Deel (vierkantje met pijl omhoog).
3. Kies "Zet op beginscherm" en tik op "Voeg toe".

Een PDF uit een andere app (bijv. de bank-app): kies daar "Bewaar in Bestanden", open PdfReader en tik op "PDF openen".

**Android (Chrome)**
1. Open de site in Chrome.
2. Tik op "Installeer app" in PdfReader, of op ⋮ → "App installeren" / "Toevoegen aan startscherm".
3. Daarna staat PdfReader in het deelmenu: deel een PDF vanuit een andere app naar PdfReader.

**Computer (Chrome / Edge)**
Klik op "Installeer app" of op het installatie-icoon in de adresbalk. Daarna kun je PDF's openen via "Openen met → PdfReader".

## Techniek

Statische PWA zonder build-stap: `index.html`, `css/`, `js/` (ES-modules), `sw.js` (service worker), `manifest.webmanifest`, `icons/`.
Rendering met [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0), lokaal meegeleverd in `vendor/pdfjs/` – zie de README daar.
Strikte Content-Security-Policy, geen externe verzoeken.

Lokaal testen: `python3 -m http.server` in deze map en open http://localhost:8000/.
Bij een nieuwe release: verhoog `VERSION` in `sw.js`.

<!-- fix-1 -->
<!-- fix-2 -->
# PdfReader

Een rustige, reclamevrije PDF-lezer die in de browser draait: **https://bruindav.github.io/PdfReader/**

- Geen reclame, geen tracking, geen account. Je bestand blijft op je eigen toestel (er wordt niets geüpload).
- PDF openen via de knop, slepen (computer) of delen vanuit een andere app (Android, na installeren).
- Zoomen met knoppen, knijpen (twee vingers), Ctrl/Cmd + scrollwiel of Ctrl/Cmd + / − / 0. Tekst blijft scherp.
- Opslaan zonder beperking: je kiest zelf map en naam (waar de browser dat toestaat); anders via Delen of Downloads. Het bestand wordt byte-voor-byte ongewijzigd opgeslagen.
- Wachtwoordbeveiligde PDF's, ga naar pagina, onthoudt per document de laatste pagina en zoom (alleen een vingerafdruk, geen inhoud).
- Werkt offline na het eerste bezoek.
- **Aantekenen** (fix-2): pen, lijn, ovaal, rechthoek en tekst, in 8 vaste kleuren of een eigen kleur, 3 lijndiktes en 3 tekstgroottes. Selecteren, verplaatsen, formaat wijzigen, verwijderen, ongedaan maken/opnieuw. Op de telefoon teken je met 1 vinger en scroll/zoom je met 2 vingers.
- Aantekeningen worden automatisch op je toestel bewaard (per document, in IndexedDB; geen PDF-inhoud) en komen terug als je dezelfde PDF opnieuw opent.
- Opslaan **met aantekeningen** (echte PDF-annotaties, zichtbaar in elke PDF-app, optioneel vastgezet in de pagina) of het **origineel** (byte-voor-byte ongewijzigd). Werkt ook bij beveiligde PDF's zoals bankafschriften.

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

### Aantekeningen (fix-2)

Modules: `js/annotations.js` (tekenmodus, invoer, selectie, tekst), `js/annot-model.js` (datamodel, geometrie, ongedaan maken), `js/annot-store.js` (IndexedDB), `js/annot-export.js` (opslaan in de PDF).

- Coördinaten worden bewaard in PDF-punten in de weergaveruimte van de pagina bij 100% (inclusief `/Rotate` en CropBox), dus onafhankelijk van de zoom. Bij opslaan worden ze met de pdf.js-viewport omgerekend naar de PDF-gebruikersruimte; gedraaide pagina's worden getest.
- Tekst gebruikt Helvetica-maten (gelijk aan Arial), zodat afbreken in de app en in de PDF identiek is.
- Een opgeslagen PDF krijgt een nieuwe tweede `/ID`, dus een eigen vingerafdruk: de aantekeningen worden bij heropenen niet dubbel geladen.
- Lokaal maximaal 50 documenten; de oudste vallen alleen af als hun aantekeningen al in een opgeslagen PDF staan (niet-opgeslagen werk wordt nooit stil gewist). "Geschiedenis wissen" wist ze na bevestiging ook.

**Opslaan met aantekeningen – twee routes**

1. *Gewone PDF's*: [pdf-lib](https://pdf-lib.js.org/) (MIT, lokaal in `vendor/pdf-lib/`, pas geladen bij het eerste opslaan). Echte annotaties `/Ink`, `/Line`, `/Square`, `/Circle`, `/FreeText` met eigen weergave (`/AP`), `/F 4` (afdrukken) en `/NM "pdfreader-<id>"`. Tekst buiten WinAnsi (bijv. Grieks/Cyrillisch) laadt `@pdf-lib/fontkit` en Noto Sans (OFL) en bedt een subset in. Optie "Aantekeningen vastzetten" tekent dezelfde weergave in de pagina-inhoud.
2. *Beveiligde (versleutelde) en digitaal ondertekende PDF's*: pdf-lib kan die niet correct herschrijven. Daarom gebruikt PdfReader dan de ingebouwde opslagfunctie van pdf.js (`saveDocument` met `annotationStorage`): een **incrementele update** achter de originele bytes, waarbij pdf.js de nieuwe objecten met dezelfde sleutel versleutelt. Vormen worden `/Ink`, tekst `/FreeText`.
   - De beveiliging blijft dus behouden (zelfde algoritme en wachtwoorden); er wordt nooit een onbeveiligde kopie gemaakt en er is geen extra bibliotheek of WebAssembly nodig (CSP ongewijzigd).
   - Getest met AES-256 (R6), AES-128 (R4) en RC4-128 (R3), met alleen een eigenaarswachtwoord (typisch voor bankafschriften) en met gebruikerswachtwoord: `qpdf --check` slaagt, PDFium en pdf.js tonen de aantekeningen, de originele tekst blijft leesbaar.
   - Een bestaande digitale handtekening blijft bij de ondertekende revisie horen (sommige apps melden wel dat het document daarna is gewijzigd).
   - Beperkingen van deze route: geen "vastzetten"; tekst moet in WinAnsi passen (Nederlands, €, é, ë e.d. werken) – anders toont alleen pdf.js de tekst goed.
   - Let op: de rechtenvlag "annoteren niet toegestaan" (`/P`) wordt niet afgedwongen; die vlag is adviserend en de aantekeningen komen als aparte laag bij je eigen document, met behoud van de versleuteling.
   - Overwogen en afgewezen: ontsleutelen met een WebAssembly-tool (qpdf-wasm; zou `'wasm-unsafe-eval'` in de CSP vereisen en levert een onbeveiligde kopie) en pagina's als afbeelding opnieuw opbouwen (tekst niet meer selecteerbaar).

Na het maken wordt het resultaat altijd met pdf.js opnieuw geopend ter controle; mislukt dat, dan volgt een melding met de knop "Origineel opslaan".

Lokaal testen: `python3 -m http.server` in deze map en open http://localhost:8000/.
Bij een nieuwe release: verhoog `VERSION` in `sw.js`.

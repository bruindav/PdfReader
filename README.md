<!-- fix-1 -->
<!-- fix-2 -->
<!-- fix-3 -->
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

**Android als echte app (fix-3)**: wil je PdfReader kiezen bij "Openen met" of als standaard-app voor PDF's (bijv. vanuit je bank-app)? Gebruik dan de Android-app hieronder.

**Computer (Chrome / Edge)**
Klik op "Installeer app" of op het installatie-icoon in de adresbalk. Daarna kun je PDF's openen via "Openen met → PdfReader".

## Android-app

Een kleine Android-app (APK) die je zelf installeert, zonder Play Store. Daarmee verschijnt PdfReader in "Openen met" en "Delen" voor PDF's en kun je hem als standaard-app voor PDF's instellen. De app toont de PdfReader-website in een eigen venster; je bestanden blijven op je telefoon.

**Downloaden**
- Vaste link naar de nieuwste versie: https://github.com/bruindav/PdfReader/releases/latest/download/PdfReader.apk
  (een nieuwe versie verschijnt automatisch als er iets in `android/` op `main` verandert).
- Testversie van een fix-branch: GitHub → tabblad *Actions* → *Android-app* → kies de run → onderaan bij *Artifacts* "PdfReader-apk" (een zip met daarin `PdfReader.apk`; je moet ingelogd zijn op GitHub).

**Installeren**
1. Open de link op je telefoon en download `PdfReader.apk`.
2. Tik op het gedownloade bestand. Android vraagt of je browser (of de app Bestanden) apps mag installeren: kies *Instellingen* → zet *Toestaan uit deze bron* aan → ga terug.
3. Tik op *Installeren*. Google Play Protect kan waarschuwen dat de app onbekend is (hij komt niet uit de Play Store): kies *Meer details* → *Toch installeren*. Vraagt Play Protect om de app te laten scannen, dan mag dat.
4. Een nieuwe versie installeer je op dezelfde manier over de oude heen; je instellingen en aantekeningen blijven bewaard.

**Als standaard-app voor PDF's instellen**
- Het makkelijkst: open een PDF in een andere app (bijv. je bank-app) → kies *PdfReader* → tik op *Altijd*.
- Of later: *Instellingen* → *Apps* → *Standaard-apps* (soms: *Apps kiezen*/*Standaard openen*). Staat er al een andere PDF-app als standaard, open dan bij díe app *Standaard openen* → *Standaardwaarden wissen*; bij de volgende PDF kun je PdfReader kiezen.
- De namen van menu's verschillen per merk (Samsung, Pixel, enz.).

**Wat werkt wel en niet**
- Werkt: PDF openen via "Openen met", "Delen" en de knop "PDF openen"; lezen, zoomen, aantekenen; opslaan op een plek die je zelf kiest (mapkiezer van Android); delen naar andere apps; offline na het eerste gebruik.
- De eerste keer heb je internet nodig (de app laadt de website, daarna staat die in de cache).
- Maximaal 200 MB per bestand.
- PDF's uit heel oude apps die een `file://`-pad doorgeven (in plaats van een gedeeld bestand) kunnen soms niet geopend worden; kies dan in die app "Delen".
- Heel oude telefoons met een verouderde "Android System WebView": werk die bij via de Play Store, anders werkt openen vanuit andere apps niet.
- De app zelf verandert weinig: nieuwe functies van PdfReader komen via de website en verschijnen ook in de app (melding "Nieuwe versie beschikbaar").

**Ondertekening (sleutel)**
Android installeert een update alleen over de oude heen als beide met dezelfde sleutel zijn ondertekend.
- Standaard gebruikt de build de **openbare ontwikkel-sleutel** `android/signing/pdfreader-dev.jks` (wachtwoord `pdfreader-dev`, staat in `android/app/build.gradle.kts`). Die staat in de repo, dus iedereen kan er een APK mee tekenen. Voor eigen gebruik is dat acceptabel zolang je de APK alleen via je eigen GitHub-repo downloadt.
- Eigen, geheime sleutel instellen (aanbevolen):
  1. Maak een sleutel (op een computer met Java):
     `keytool -genkeypair -keystore pdfreader-release.jks -storetype PKCS12 -alias pdfreader -keyalg RSA -keysize 3072 -validity 10000`
  2. Zet hem om naar tekst: `base64 -w0 pdfreader-release.jks > keystore.txt` (macOS: `base64 -i pdfreader-release.jks -o keystore.txt`).
  3. GitHub → repo *PdfReader* → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*, vier keer:
     `ANDROID_KEYSTORE_BASE64` (inhoud van keystore.txt), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (bijv. `pdfreader`), `ANDROID_KEY_PASSWORD` (bij PKCS12 gelijk aan het keystore-wachtwoord).
  4. Bewaar het .jks-bestand en de wachtwoorden goed (bijv. in je wachtwoordmanager) en verwijder keystore.txt.
  - Let op: wissel je van de ontwikkel-sleutel naar je eigen sleutel, dan moet je de app één keer verwijderen en opnieuw installeren (aantekeningen in de app gaan dan verloren; sla ze eerst op in de PDF).

**Techniek (Android)**
- Map `android/`: Kotlin, één Activity met een WebView die alleen `https://bruindav.github.io/PdfReader/` toont; andere links openen in je browser. Geen bestands- of content-toegang voor de WebView, geen gemengde inhoud, Safe Browsing aan, alleen HTTPS.
- Brug tussen app en web-app: `WebViewCompat.addWebMessageListener` (androidx.webkit), alleen beschikbaar voor de origin `https://bruindav.github.io`. Web-kant: `js/android-bridge.js`, alleen actief als het object `PdfReaderAndroid` bestaat. Bestanden gaan in stukken van 512 KB (als ArrayBuffer, of base64 op oudere WebViews). Bij een koude start wacht de app met het bestand tot de web-app "ready" meldt.
- Opslaan: de web-app stuurt de bytes naar de app, die opent de Android-mapkiezer (`ACTION_CREATE_DOCUMENT`); delen via `ACTION_SEND` met een FileProvider.
- Bouwen: GitHub Actions (`.github/workflows/android.yml`), JDK 17, Gradle-wrapper in `android/`. Lokaal: `cd android && ./gradlew assembleRelease` (Android SDK nodig).

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

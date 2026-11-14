<!-- fix-1 -->
# pdf.js (Mozilla) – lokaal meegeleverd

- Pakket: `pdfjs-dist` **5.7.284** (legacy build, voor bredere browserondersteuning), licentie Apache-2.0 (zie `LICENSE`).
- Toegevoegd in **fix-1**. De bestanden in deze map zijn ongewijzigd overgenomen uit het npm-pakket.
- Inhoud: `pdf.min.mjs`, `pdf.worker.min.mjs` (uit `legacy/build/`), `cmaps/`, `standard_fonts/`, `iccs/`, `wasm/` (zonder `quickjs-eval`: PdfReader voert geen JavaScript uit PDF's uit).
- Veiligheid: versie ≥ 4.2.67 (CVE-2024-4367); de app gebruikt `isEvalSupported: false`.

Bijwerken:
```sh
npm pack pdfjs-dist@<versie> && tar xzf pdfjs-dist-<versie>.tgz
cp package/legacy/build/pdf.min.mjs package/legacy/build/pdf.worker.min.mjs vendor/pdfjs/
cp -r package/cmaps package/standard_fonts package/iccs vendor/pdfjs/
```
Verhoog daarna `VERSION` in `sw.js` en controleer de bestandslijst daarin.

<!-- fix-2 -->
# pdf-lib + fontkit – lokaal meegeleverd

Toegevoegd in **fix-2**. De bestanden zijn ongewijzigd overgenomen uit de npm-pakketten (`npm pack`).

| Bestand | Pakket | Licentie | sha256 |
|---|---|---|---|
| `pdf-lib.esm.min.js` | `pdf-lib` **1.17.1** (`dist/`) | MIT (`LICENSE-pdf-lib.md`) | `72c052d9…d969` |
| `fontkit.umd.min.js` | `@pdf-lib/fontkit` **1.1.1** (`dist/`) | MIT (volgens package.json; © Devon Govett e.a.) | `d8df561b…a35a6` |

- Alleen geladen bij "Opslaan met aantekeningen" van een niet-versleutelde PDF (dynamische `import()`); fontkit alleen voor tekst buiten WinAnsi. De UMD-bundel zet `self.fontkit`.
- Geen `eval`/`new Function`: werkt binnen de strikte CSP (`script-src 'self'`).
- `pdf-lib.esm.min.js` staat in de precache van `sw.js`; fontkit en het lettertype worden bij eerste gebruik gecachet.

Bijwerken:
```sh
npm pack pdf-lib@<versie> @pdf-lib/fontkit@<versie>
tar xzf pdf-lib-<versie>.tgz && cp package/dist/pdf-lib.esm.min.js package/LICENSE.md vendor/pdf-lib/
```
Verhoog daarna `VERSION` in `sw.js`.

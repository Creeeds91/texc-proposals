# pdf.js, vendored

The document viewer (`assets/js/pdf-viewer.js`) draws PDFs with Mozilla's
pdf.js, self-hosted here so a client's documents never depend on a third-party
script host, and so the page's CSP can stay `script-src 'self'`.

| | |
|---|---|
| Package | `pdfjs-dist` **5.4.624** (Apache-2.0, `5.4.624/LICENSE`) |
| Source | `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-5.4.624.tgz` |
| Integrity | `sha512-sm6TxKTtWv1Oh6n3C6J6a8odejb5uO4A4zo/2dgkHuC0iu8ZMAXOezEODkVaoVp8nX1Xzr+0WxFJJmUr45hQzg==` (matches npm's published value, checked 13 Oct 2026) |
| Build | the **legacy** build, which carries the polyfills older iPhones and Android phones need: `legacy/build/pdf.min.mjs` and `pdf.worker.min.mjs`, saved here as `pdf.min.js` and `pdf.worker.min.js` — renamed, not changed, so every host serves them as JavaScript (a module with the wrong type is refused) |
| Also | `cmaps/`, `standard_fonts/`, `wasm/` (JPEG 2000, JBIG2 and colour decoders, with the plain-script fallback), `iccs/` — each with its own licence file |

Nothing here is edited. `5.4.624/SHA256SUMS` lists every file, and
`node scripts/check.mjs attachments` fails if any file differs from it or is not
in it.

**To upgrade:** download the new tarball from the registry, check its sha512
against `npm view pdfjs-dist@<version> dist.integrity`, copy the same files into
a new `<version>/` folder beside this one (the two `.mjs` files renamed to `.js`), regenerate `SHA256SUMS`
(`find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS`),
change the one path in `assets/js/pdf-viewer.js`, and run the attachments,
render and flow checks. Remove the old folder only when nothing points at it.

How it runs: `isEvalSupported: false` (font programs are never compiled into
code), the PDF's own scripts are never run, and the worker gets its own
narrower CSP (`lib/csp.js` `WORKER_CSP`, sent by `vercel.json` with
`/assets/vendor/`).

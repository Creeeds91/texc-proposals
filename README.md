# TEXC Proposals

Client shotfiring proposals for TEXC Pty Ltd. A client gets a private link and
a passphrase, reads a long-scrolling proposal in TEXC's design, opens the
attached documents and accepts online. Staff build each proposal in an editor
over the live page, and every revision is archived.

Built by Brand in Black. Plan: `docs/architecture.md`. What still needs TEXC:
`docs/open-items.md`. Working rules: `CLAUDE.md`.

## Where it is up to

| Phase | What | Status |
|---|---|---|
| 0 | Plan | Approved 13 Oct 2026 |
| 1 | Static client page from a demo config | **This build** |
| 2 | Editor | — |
| 3 | Database, accounts, publishing, gate, revisions | — |
| 4 | PDF attachments | — |
| 5 | Online acceptance | — |
| 6 | Archive and dashboard | — |
| 7 | Hardening and handover | — |

## Run it

Node 22.15 or later. No dependencies to install.

```bash
node scripts/build.mjs           # templates -> views
node scripts/demo/serve.mjs      # http://127.0.0.1:4310/demo, with production's headers
node scripts/check.mjs           # all checks
node scripts/demo/capture.mjs    # screenshots, scroll video and A4 PDF into demo-out/
```

The content sync and the token-drift check read a sibling checkout of the
website:

```bash
git clone https://github.com/Creeeds91/texc ../texc
node scripts/texc-content-sync.mjs
```

Browser checks use Playwright if it is available (the cloud container ships
it); without it they report NOT CHECKED rather than passing.

## Layout

```
templates/proposal.html   the page, with its data-* contract
assets/css/               tokens.css (from the website), proposal.css, print.css
assets/js/proposal.js     the runtime: applyConfig, initEffects, whenImagesReady
assets/js/money.js        quote arithmetic, shared by browser and server
content/                  website snapshot, locked lines, suite register, workflow
fixtures/                 the demo proposal (fictional client and site)
lib/brand.js              the only place the business is named
scripts/                  build, checks, content sync, local server, captures
views/                    generated pages — never edit
```

## Demo content

`fixtures/demo-proposal.json` is fictional: Ashgrove Civil Pty Ltd at Ashgrove
Heights. Its structure follows TEXC's 2 Chalmers Lane documents and its
hazard, process and hold-point wording is TEXC's own, with the client swapped.
Rates and terms are placeholders from a superseded prototype. Photographs are
TEXC's own, captioned as illustrative. Nothing in it is approved for a real
proposal.

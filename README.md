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
| 1 | Static client page from a demo config | Built 13 Oct 2026 |
| 2 | Editor | **This build** |
| 3 | Database, accounts, publishing, gate, revisions | — |
| 4 | PDF attachments | — |
| 5 | Online acceptance | — |
| 6 | Archive and dashboard | — |
| 7 | Hardening and handover | — |

## Run it

Node 22.15 or later. No dependencies to install.

```bash
node scripts/build.mjs           # templates -> views and the editor page
node scripts/demo/serve.mjs      # http://127.0.0.1:4310/demo and /editor, with production's headers
node scripts/check.mjs           # all checks
node scripts/demo/capture.mjs    # screenshots, scroll video and A4 PDF into demo-out/
node scripts/demo/capture.mjs --editor   # just the editor screenshots
```

## The editor

Open `http://127.0.0.1:4310/editor`. The proposal fills the screen and the
editor sits in a drawer on the left (on a phone, a full-screen sheet with
Edit / Preview at the foot). Every keystroke shows on the page as the client
will see it.

- **Draft** menu: start a new proposal, load the demo, import or export a
  draft as `.json`.
- **Sections**: open one to edit it; the switch shows or hides it; drag the
  handle (or Alt+↑ / Alt+↓) to reorder. Cover stays first; acceptance and
  contact stay last. Each badge says what is left to fix or acknowledge.
- **Library** buttons insert TEXC's wording (Chalmers Lane presets, the
  status callout, prototype rates). Inserted wording is the proposal's own
  copy, and the checklist asks for it to be reviewed for this site.
- **Mark CONFIRM** on any field flags it as waiting on TEXC. The text stays
  as a suggestion, the page shows a red CONFIRM tag, and it cannot be
  published until confirmed.
- **Checklist**: what blocks publishing, and what must be acknowledged first.
- **Drafts save to this browser** (photos too) until Phase 3 moves them to the
  server. Clearing browser data clears the draft: export it to keep a copy.

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
assets/js/checks.js       the pre-publish checklist, shared by editor and server
assets/js/sensitive.js    likely-sensitive text (coordinates, magazines, quantities, routes)
assets/js/schema.js       sections, document types, status labels
assets/js/editor/         the editor drawer: panels, fields, photos, autosave, checklist
assets/css/editor.css     the drawer's styles (editor page only)
content/                  website snapshot, locked lines, suite register, workflow,
                          and library.seed.json (the editor's starting library)
fixtures/                 the demo proposal (fictional client and site)
lib/brand.js              the only place the business is named
lib/csp.js                the client and editor Content Security Policies
lib/editor-html.js        generated editor page, served behind sign-in from Phase 3
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

# CLAUDE.md — TEXC Proposals

Read automatically at the start of every session in this repo.

TEXC Pty Ltd is a licensed Tasmanian shotfiring contractor. This repo is its
client proposal system: a password-gated proposal page a client reads, opens
documents from and accepts; an editor staff build it in; an archive of every
revision. Brand in Black builds it. It is **Bespoke-tier** client work, and the
business behind it is compliance-driven — a wrong line on a proposal reads as
authoritative on a blast site.

The approved plan is `docs/architecture.md`. What still needs TEXC is
`docs/open-items.md`.

---

## Posture

- Cautious. Ask before anything destructive. Never force-push. Never write to a
  production database or bucket without being asked.
- Work in the phases of `docs/architecture.md` §9, and stop for approval at the
  end of each one.
- Australian spelling. No emoji. No hype, no exclamation marks.

## Never invent operational content

Hazards, controls, distances, vibration limits, product names, legislative or
Standard references, emergency numbers, licence codes, insurance values and
prices come from TEXC, never from us. Where content is needed and unconfirmed:

- store it as `{"$confirm": "what is needed"}` — never a string;
- list it in `docs/open-items.md`.

The runtime cannot print a `$confirm` on a client page (it renders as nothing;
in editor mode it renders as a red CONFIRM tag). `node scripts/check.mjs confirm`
proves it. Phase 3 adds the server-side publish refusal.

The approved TEXC wording this system reuses is copied, never retyped:

- **Website copy** (service scope and safety lines, About, capability strip,
  George's profile) comes from `../texc/content/*.ts` through
  `node scripts/texc-content-sync.mjs`, into `content/texc-snapshot.json`.
  Re-run it after any website copy change and review the diff.
- **Locked lines** (preliminary status, "No blasting activity will proceed
  until…", misfire, 000, HP1 framing) are in `content/locked-lines.json`, each
  with its source. A proposal can hide one where its section allows, never
  reword it.
- **The suite register** (`content/register.json`) and **workflow**
  (`content/workflow.json`) are copied exactly from `../texc/documents/`.

Website service `safety` lines are compliance-driven: do not soften or drop
them. Pending services (Remote Area Operations, Marine & Coastal) are never
offered. TEXC12 is a draft and is never offered.

## The brand is one file

`lib/brand.js` is the only place the machinery names the business — name,
entity, ABN, phone, email, principal. Templates use `{{brand.<key>}}`; the build
writes the brand into each page as a JSON data block. `check.mjs brand` fails
the moment one is typed elsewhere.

## The client page runs under a strict CSP

`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, no
`'unsafe-inline'`, `frame-ancestors 'none'` (`vercel.json`). So:

- no inline `<script>` that executes — data goes in `<script type="application/json">`;
- no `<style>` element, no `style=""` attribute, no `on*=""` handler;
- setting `element.style` or a custom property from JS is fine (CSSOM).

`scripts/build.mjs` refuses to write a view that breaks any of these, and
`scripts/demo/serve.mjs` serves locally with the exact `vercel.json` headers, so
a CSP mistake shows up on your machine, not in production. Do not insert
`@page` rules through the CSSOM: reading one back crashes Chromium's renderer.

## The template contract

`templates/proposal.html` + `assets/js/proposal.js`, modelled on the Roberts
IAP. Bindings: `data-field`, `data-empty`, `data-img`, `data-paras`, `data-list`,
`data-rows` (clone-first-row; `data-rows-default` restores built-in rows when the
key is absent), `data-col*` inside rows, `data-hide-empty`, `data-locked`,
`data-snap`, `data-reveal`, `data-sec`. The runtime exports `applyConfig`,
`initEffects`, `whenImagesReady`. **A key absent from a config restores the
built-in default** — never the previous proposal's value.
`check.mjs contract --prove` holds the hook list and proves it bites.

Each proposal keeps the design it was sent in: a revision stores its
`template` version. A change that would alter an issued proposal ships as a new
template version beside the old one.

## The editor

`/editor` is the same page with `data-mode="editor"` and a drawer
(`assets/js/editor/*`, `assets/css/editor.css`). It is built into
`lib/editor-html.js` and is never a public static page: the local server serves
it now, `api/editor.js` behind sign-in from Phase 3. Its CSP (`lib/csp.js`
`EDITOR_CSP`) differs from the client page's only by `img-src blob:`, and
`check.mjs csp` holds it there.

- The checklist rules live in `assets/js/checks.js` and are shared with the
  server's publish check (Phase 3), so the editor can never pass what the
  server refuses. Change a rule there, then add its case to `check.mjs rules`.
- Library wording derived from 2 Chalmers Lane must stay TEXC's exact words
  (`{client}` aside); `check.mjs content-sync` checks every line against the
  source. Inserting library text records it in `presetsUsed`, and its
  `confirm` note must be acknowledged before publishing.
- The sensitive-text scan (`assets/js/sensitive.js`) warns and never blocks;
  each warning must be acknowledged, and an acknowledgement is tied to the
  exact text it was given for.
- Machinery text names the business through `BRAND` (`ctx.BRAND.name` in the
  editor, `ctx.brand` in `runChecks`), never by typing it.
- `check.mjs editor` walks the editor in Chromium. After any editor change, run
  it and `node scripts/demo/capture.mjs --editor`, and look at the captures.

## Generated files

`views/*.html` and `lib/editor-html.js` are built by `node scripts/build.mjs`
from `templates/proposal.html`. Never hand-edit them. The build is deterministic: a
clean `git status` after building means they are current, and `check.mjs csp`
fails if they are stale. `content/texc-snapshot.json` is generated by the sync
script. `demo-out/` is git-ignored.

## Design

Tokens are copied verbatim from `../texc/app/globals.css` into
`assets/css/tokens.css`; `check.mjs content-sync` fails on drift. Never a hex in
a component. Oxanium 800 (OFL) is self-hosted. **Basement Grotesque is not
shipped until TEXC confirms its licence covers this property** (open item C26) —
labels and body run on a fallback stack until then. Never Eurostile.
`check.mjs design` fails on a raw colour in any stylesheet but `tokens.css`;
a translucent scrim uses a channel token, `rgb(var(--ink-rgb) / 0.8)`.

Only TEXC's own photography; never the website's `stock-*` images; never a
photo presented as a site it is not of.

## Before you push

```bash
node scripts/build.mjs
node scripts/check.mjs            # every suite; exit 3 = something NOT CHECKED
node scripts/demo/capture.mjs     # stills at 1440 and 390, scroll video, A4 PDF
```

A skip (exit 3) is "not checked", never "fine". Look at every capture before
sending it — a half-faded reveal, a stitched sticky bar or a blank frame is a
bad capture, not a finding. Show changes as screenshots, not descriptions.

Job references use `BIB-####` and are preserved exactly.

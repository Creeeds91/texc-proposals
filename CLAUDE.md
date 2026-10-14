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
in editor mode it renders as a red CONFIRM tag), and the server refuses to
publish one (the shared checklist, then `lib/projection.js`, then a scan of the
bytes). `node scripts/check.mjs confirm refusals` proves both.

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

## The database and the server (Phase 3)

`supabase/schema.sql` is the single source of truth for the database. Change
the live structure only through it, in the same change, idempotent
(`if not exists`, `create or replace`). Column order is load-bearing: a column
added later is appended with `alter table … add column`, never tidied into the
`create table`. Prove every change with `node scripts/schema-standup-check.mjs`
(a fresh local Postgres + PostgREST; nothing hosted is touched).

- **Never write to a hosted database, bucket or mailbox without being asked.**
  `scripts/demo/local-app.mjs` runs the whole app locally from an empty
  database; use it.
- Published revisions are immutable and the logs append-only, by trigger.
  Never work around them; a later phase's super-only purge is the one door.
- Every client-facing refusal is the identical 410 (`lib/http.js` GONE);
  record-only endpoints answer 204. `check.mjs refusals` holds this.
- What a client receives is built by allowlist in `lib/projection.js`. A new
  config field reaches a client only when it is added there, on purpose.
- The passphrase is never logged, emailed or stored unsealed (`lib/vault.js`).
  It is shown on first publish, on an audited read-back, and on rotation.
- Server code: no `console.*`, no `select=*`, no database error text echoed to
  a caller (`check.mjs conventions`). The secret key goes in the `apikey`
  header only.
- Endpoints never read `content/` or `templates/` at run time; they import the
  generated `lib/template-data.js`, `lib/editor-html.js`, `lib/signin-html.js`, `lib/dashboard-html.js`, `lib/library-html.js`,
  `lib/revision-html.js`, `lib/archive-html.js`.

## Attachments (Phase 4)

`docs/architecture.md` §15 is the design. What must hold:

- **Only a checked file reaches a client.** A client-visible card needs a file
  whose verdict is `clean`, or `override` (an administrator's audited release
  with a reason). The checklist (`assets/js/checks.js`), `lib/projection.js`
  and the revision's `attachments_snapshot` all enforce it. Never weaken
  `lib/pdf-inspect.js` to let a file through: attach a flattened copy, or
  release it. TEXC's suite PDFs carry scripts and are refused as issued.
- **The client's endpoint reads the file from the revision's snapshot,
  never from the request**, and refuses with the uniform 410.
- **Nothing that can never be served is kept**: not a PDF, encrypted, a "zip
  bomb". A genuine large drawing is "cannot verify", never refused outright.
- **pdf.js is vendored, never edited** (`assets/vendor/pdfjs/README.md`). An
  upgrade is a new version folder, a new `SHA256SUMS`, one path in
  `assets/js/pdf-viewer.js`. `check.mjs attachments` fails on any drift.
- After any change here run `check.mjs attachments refusals editor flow` and
  `node scripts/demo/capture.mjs --phase4`, and look at the captures.

## Acceptance (Phase 5)

`docs/architecture.md` §16 is the design. What must hold:

- **A client accepts exactly what was published**: the current revision, the
  SHA-256 of the bytes they decrypted equal to the revision's, and a total
  the server recomputes from the revision's own quote snapshot. Never accept
  on anything the request says about the content.
- **One acceptance per revision, written by `texc_accept()` with the proposal
  locked.** `texc_acceptances` is append-only; never work around it. A
  mistake is answered by a new revision, not an edit.
- **The record is rendered once, stored, fingerprinted, and never
  regenerated.** It is served only after its bytes match `record_sha256`.
- **Wording comes from the revision**: the HP1 framing is the frozen locked
  line, the next hold point is the revision's own. Never type operational
  wording into an email or the record.
- The sentences a client ticks live in `assets/js/acceptance.js`, shared with
  the server; change them there and nowhere else.
- After any change here run `check.mjs schema acceptance flow` and
  `node scripts/demo/capture.mjs --phase5`, and look at the captures.

## Archive and dashboard (Phase 6)

`docs/architecture.md` §17 is the design. What must hold:

- **One set of rules.** States, follow-ups, periods, figures and list filters
  live in `assets/js/lifecycle.js`, shared by the page and the CSV export.
  Never compute a figure a second way; change it there and add its case to
  `check.mjs lifecycle`. The database only counts (`texc_overview()`).
- **Archiving is not withdrawing and never deletes.** While archived, every
  client endpoint refuses with the uniform 410 (`lib/client-access.js`), and
  saves, publishing and acceptance are refused (the server and the database
  both). Only the Phase 7 purge deletes.
- **What reaches the dashboard is what it needs**: no link token, passphrase
  or proposal content in `texc_overview()`; the client link only for editors
  and above.
- **The CSV defuses formulas and is audited before it is sent.** Same-site
  only. Never add a column holding anything a viewer could not already see.
- **Practice proposals never count** in a figure or a follow-up.
- After any change here run `check.mjs lifecycle schema dashboard` and
  `node scripts/demo/capture.mjs --phase6`, and look at the captures.

## Hardening (Phase 7)

`docs/architecture.md` §18 is the record; `docs/handover.md` the go-live.

- **Deleting is `texc_purge()` and nothing else**: Brand in Black only, 90
  days after archiving, never an accepted proposal, by typing the reference,
  audited before anything goes. Never set `texc.purge` anywhere else.
- **The PDF check fails closed.** Anything a reader might read differently
  (repeated keys, comments, abbreviated keys, decode parameters, a stream it
  cannot place) is "cannot verify". Never loosen a rule to let a file
  through; every bypass found is a fixture in `scripts/lib/pdf-fixtures.mjs`
  and `check.mjs attachments` holds them.
- **A stored document's path carries its whole SHA-256**, and nothing deletes
  a stored file a record points at. A file being checked is claimed first.
- **Accessibility and speed are checked, not hoped for**: `check.mjs a11y`
  (axe-core, WCAG 2.2 AA, every page, 1440 and 390), `lighthouse` (phone,
  at least 95), `budget` (200 KB before photographs). The tools live outside
  the repo (`scripts/lib/audit-tools.mjs`); without them those suites report
  NOT CHECKED.
- After any change to the client page run `check.mjs render print a11y budget
  lighthouse`; after any change to the staff pages, `a11y`.
- **Every path gets exactly one security policy, from one place**: `vercel.json`
  for static files and plain endpoints, the function itself for a page that
  sets its own (the editor, the acceptance record, the Archive, a sent
  revision). Never let two rules match
  one path; `check.mjs csp` fails if they do.
- **A deployment is checked from outside**: `node scripts/deploy-check.mjs
  --url <address>` (GET requests only; `--production` once live). `check.mjs
  deploy` runs it against the local app and against a careless server it must
  catch. Attaching and opening a document on a preview stays by hand (D4, D5).

## Document library (Phase 8)

`docs/architecture.md` §19 is the design. What must hold:

- **One table, the TEXC app's EvidenceItem**: a document belongs to the
  organisation or one person, with George's kinds. Keep it that shape, so it
  can move into the TEXC app (texc repo, `documents/process/app-foundation.md`)
  unchanged.
- **An approved library file is a record**: never changed, never deleted (the
  database refuses). A renewal is a new file; a document that had a file is
  retired, not deleted. A purge never touches `library/`.
- **Publishing freezes the CURRENT approved file into the revision**, with the
  library's code, revision, date and expiry. Never let a card's own values, or
  a later approval, change what a revision already sent.
- **Every library file gets the same check as a proposal's** (one function,
  `verifyStored`). Only an administrator changes the library, audited first.
- Generating project documents belongs to the converter in the texc repo, not
  here: never add a second house-style renderer.
- After any change here run `check.mjs schema library editor lifecycle a11y`
  and `node scripts/demo/capture.mjs --phase8`, and look at the captures.

## Archive and retention (Phase 9)

`docs/architecture.md` §20 is the design. What must hold:

- **The archive shows what was sent, never what is there now.** A revision
  opens from its own `published_text` and its documents from its own
  `attachments_snapshot`; search reads the same. Never fill a gap from the
  draft, the library or the proposal row.
- **The staff revision view is the client page**, built from the same
  template and runtime, booted by `assets/js/archive-view.js`. It records
  nothing as the client's and offers nothing to accept. A design change that
  would alter an old revision ships as a new template version, as ever.
- **Only a sent revision may be framed, and only by this origin**
  (`REVISION_CSP`, `X-Frame-Options: SAMEORIGIN`); the Archive page alone may
  frame (`ARCHIVE_CSP`). `check.mjs csp` holds it; never widen either.
- **A record pack is evidence**: every file fingerprinted and compared with
  the fingerprint recorded at the time; a mismatch is packed and named, never
  dropped or hidden. Editors and above, audited before anything is sent;
  nothing is assembled or kept on the server. The readable copy is a
  convenience; `published.json` is the record.
- **Keeping periods are TEXC's** (C43): never set a default. Unset, nothing
  is archived automatically and no accepted proposal can be deleted. The
  daily run only archives, as `retention`, through `texc_set_archived`;
  deletion stays `texc_purge()`, which now also waits out the keeping period.
- After any change here run `check.mjs schema archive lifecycle csp a11y
  deploy` and `node scripts/demo/capture.mjs --phase9`, and look at the
  captures.

## Generated files

`views/*.html` (404 included), `lib/editor-html.js`, `lib/signin-html.js`, `lib/dashboard-html.js`, `lib/library-html.js`,
`lib/revision-html.js`, `lib/archive-html.js`,
`lib/template-data.js` and `lib/demo-fixture.js` are built by
`node scripts/build.mjs`. Never hand-edit them. `public/` (what Vercel serves)
is written by `--public` and is git-ignored. The build is deterministic: a
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
node scripts/demo/capture.mjs     # stills at 1440 and 390, scroll videos, A4 PDF, editor and Phase 3–8 screens
```

A skip (exit 3) is "not checked", never "fine". Look at every capture before
sending it — a half-faded reveal, a stitched sticky bar or a blank frame is a
bad capture, not a finding. Show changes as screenshots, not descriptions.

Job references use `BIB-####` and are preserved exactly.

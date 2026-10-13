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
| 2 | Editor | Built 13 Oct 2026 |
| 3 | Database, accounts, publishing, gate, revisions | Built 13 Oct 2026 |
| 4 | PDF attachments: upload, check, release, viewer, download | Built 13 Oct 2026 |
| 5 | Online acceptance: signature, record, re-acceptance, request changes | **This build** |
| 6 | Archive and dashboard | — |
| 7 | Hardening and handover | — |

## Run it

Node 22.15 or later. No dependencies to install.

```bash
node scripts/build.mjs             # templates -> views, the editor and sign-in pages, server modules
node scripts/demo/local-app.mjs    # the whole app on a fresh local database: http://127.0.0.1:4400/signin
node scripts/demo/serve.mjs        # just the client demo page, with production's headers
node scripts/check.mjs             # all checks
node scripts/schema-standup-check.mjs   # prove supabase/schema.sql on a fresh database
node scripts/demo/capture.mjs      # screenshots, scroll videos and A4 PDF into demo-out/ (--editor, --phase3, --phase4, --phase5 for one set)
```

The local app needs Postgres 16 and Docker (the cloud container has both). It
runs the real `api/*` handlers in front of a real Postgres and the real
PostgREST, with a file-backed stand-in for Storage, and starts from an empty
database every time. Sign in as `studio@example.com`; the "emailed" code is at
`/__dev/outbox`. Nothing touches a hosted database, bucket or mailbox.

## Deploying (not yet done)

1. A Supabase project in Sydney (paid plan: free projects pause, which takes
   live links down). Run `supabase/schema.sql` in its SQL editor; create the
   private buckets `texc-media`, `texc-attachments`, `texc-acceptances`.
2. A Vercel project on this repository, with the variables in `.env.example`.
3. On the first preview deployment, check that `/lib/editor-html.js` and
   `/content/library.seed.json` answer 404 (open item D1); attach, view and
   download one document with the console open (D4, D5); then narrow the
   storage origin in `lib/csp.js` and `vercel.json` to the project's own.

## The editor

Sign in at `/signin`, then open or start a proposal. The proposal fills the screen and the
editor sits in a drawer on the left (on a phone, a full-screen sheet with
Edit / Preview at the foot). Every keystroke shows on the page as the client
will see it.

- **Menu**: all proposals, a new one, the demo, import or export a draft as
  `.json`; for administrators also the passphrase (read back, recorded), a new
  link and passphrase, withdraw, and People (approving access).
- **Sections**: open one to edit it; the switch shows or hides it; drag the
  handle (or Alt+↑ / Alt+↓) to reorder. Cover stays first; acceptance and
  contact stay last. Each badge says what is left to fix or acknowledge.
- **Library** buttons insert TEXC's wording (Chalmers Lane presets, the
  status callout, prototype rates). Inserted wording is the proposal's own
  copy, and the checklist asks for it to be reviewed for this site.
- **Mark CONFIRM** on any field flags it as waiting on TEXC. The text stays
  as a suggestion, the page shows a red CONFIRM tag, and it cannot be
  published until confirmed.
- **Checklist**: what blocks publishing, what must be acknowledged first, and
  what changed since the last revision. When it reads Ready, **Publish** issues
  the next revision and shows the client link and, the first time only, the
  passphrase. Send them separately: the link by email, the passphrase by phone
  or text message.
- **Documents**: each card the client can open needs a PDF (up to 25 MB).
  Attach it on the card; it goes straight to private storage and is checked
  before it can be sent. Anything that can run — scripts, launch actions,
  embedded files — is refused, with the reason on the card. TEXC's own suite
  PDFs carry calculation scripts, so attach a flattened copy (open it and print
  it to PDF). An administrator can release a file the check refused or could
  not verify, with a reason that is recorded. Preview shows it as the client
  will.
- **Acceptance**: the status line under the title says who accepted which
  revision, with a link to the acceptance record (printable). Publishing over
  an accepted revision asks you to acknowledge that the client must accept
  again. Administrators can record an acceptance that came by email or on
  paper (Menu), with a note; it is recorded and cannot be undone.
- **Drafts save to the server** every few seconds. If a colleague saved first,
  the editor asks whether to load theirs or keep yours; nothing is overwritten
  silently. Unsaved changes are also kept in the browser until the server has them.

## The client's side

A client opens `/p/<slug>?t=<token>` and types the passphrase. The proposal is
decrypted in their browser; nothing of it is visible before that. A new
revision appears behind the same link; earlier ones stay readable, marked
superseded. A withdrawn, expired or rotated link shows "This link is no longer
active", identically for every reason.

Documents open in a viewer on the page (View), in a new tab, or download under
the proposal's reference (Download). Each is a 60-second link to a file the
client's own revision offers, and each open and download is recorded.

To accept, the client fills in their details, ticks both confirmations and
signs (drawn or typed, as the proposal allows), on the current revision. The
server checks they accepted exactly the text that was published and the total
they were shown, and records it once; the office and the client are emailed.
The page then shows who accepted and when. A later revision asks them to
accept again. "Request changes" sends the office a message instead.

The content sync and the token-drift check read a sibling checkout of the
website:

```bash
git clone https://github.com/Creeeds91/texc ../texc
node scripts/texc-content-sync.mjs
```

Browser checks use Playwright if it is available (the cloud container ships
it); without it they report NOT CHECKED rather than passing. The attachments
check also reads TEXC's suite PDFs from that sibling checkout, with poppler
(`pdfinfo`, `pdftocairo`) and Python's pypdf as the second opinion; without
them that part reports NOT CHECKED.

## Layout

```
templates/proposal.html   the page, with its data-* contract
assets/css/               tokens.css (from the website), proposal.css, print.css
assets/js/proposal.js     the runtime: applyConfig, initEffects, whenImagesReady
assets/js/money.js        quote arithmetic, shared by browser and server
assets/js/checks.js       the pre-publish checklist, shared by editor and server
assets/js/sensitive.js    likely-sensitive text (coordinates, magazines, quantities, routes)
assets/js/schema.js       sections, document types, status labels
assets/js/gate.js         the client's passphrase gate; envelope-client.js decrypts
assets/js/pdf-viewer.js   the document viewer (pdf.js, loaded on first use)
assets/vendor/pdfjs/      pdf.js 5.4.624, self-hosted, checksummed — never edit
assets/js/signin.js       the staff sign-in page
assets/js/editor/         the editor drawer: panels, fields, photos, autosave, checklist
assets/css/editor.css     the drawer's styles (editor page only)
content/                  website snapshot, locked lines, suite register, workflow,
                          and library.seed.json (the editor's starting library)
fixtures/                 the demo proposal (fictional client and site)
lib/brand.js              the only place the business is named
lib/csp.js                the client and editor Content Security Policies
lib/accounts.js           sign-in codes, sessions, roles
lib/envelope.js           encryption at publish; vault.js seals passphrases at rest
lib/projection.js         what a client receives, by allowlist
lib/proposals.js          publish, rotate, withdraw, read back
lib/pdf-inspect.js        the structural PDF check
lib/attachments.js        a file's three steps up: begin, upload, verify
lib/acceptances.js        accepting: the checks, the one-winner write, the emails
lib/acceptance-record.js  the stored acceptance record page and its CSP
assets/js/acceptance.js   acceptance wording and rules, shared by page and server
assets/js/signature.js    the signature pad (loaded on demand)
lib/*-html.js, lib/template-data.js, lib/demo-fixture.js   generated by the build
api/                      the endpoints (staff and client)
supabase/schema.sql       the database: tables, triggers, functions, lock-down
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

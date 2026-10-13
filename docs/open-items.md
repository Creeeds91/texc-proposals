# Open items

Everything this system needs TEXC (or Brand in Black) to confirm before a real
proposal goes out. Nothing here is guessed in the build: an unconfirmed value is
a `{"$confirm": "…"}` in a proposal's config, which the client page cannot
print (see `docs/architecture.md`, "CONFIRM can never reach a client").

Status: **Open** unless marked otherwise. Update this file whenever an item is
answered, and say where the answer came from.

## Content and facts — from TEXC

| # | Item | Why it is open | Where it shows |
|---|---|---|---|
| C1 | Rate presets: $150/hr, 4h minimum per mobilisation, standby 50%, travel agreed or 50%, weekly/per-mobilisation invoicing on 14 days, mobilisation at cost + GST, labour-only | Only source is a superseded prototype (`texc/documents/phase-2-proof/_ds/…/_ds_bundle.js`, "Rates") | Quotation. The demo uses these figures as placeholders. |
| C2 | Payment terms, default validity period, link-expiry period | None supplied | Quotation terms, cover "Valid until" |
| C3 | Terms and conditions text and version | None exist | Section 18 stays collapsed-and-hidden; the acceptance wording omits "terms" while none exist |
| C4 | Insurance wording | The prototype's "Full insurance & compliance coverage" is not usable; the website's neutral line is used | Section 18 statement |
| C5 | George's 11 units and 3 licences; suffix inconsistencies (RIIBLA401, RIIBLA402, RIIPLA403) | Marked CONFIRM on the website | Team card shows none until each is marked confirmed |
| C6 | Street address, 19 Wynwood Road, Sprent TAS 7315 | Only in `documents/`; CCR-20 keeps storage addresses off documents | Not used |
| C7 | Emergency response number 1800 833 111 | CCR-19 | Not used |
| C8 | National vs Tasmania-only wording | `site.ts` says Tasmania; three website pages say "nationally where authorised" | Capability strip says "Tasmania wide" (website wording) |
| C9 | Proposal reference format `TEXC-P-YYYY-NNN` | A proposal number outside the document-code taxonomy in `documents/register.md` | Cover, footer, acceptance |
| C10 | Client-facing status wording | TEXC's own is "Preliminary - For Review"; the build uses it verbatim | Status chip |
| C11 | Misfire line adapted: "an enquiry form is not an emergency channel" → "this proposal is not an emergency channel" | Compliance line from `services.ts` | Section 18 |
| C12 | Covering-letter template | New text, drafted for the demo | Section 02 |
| C13 | Hazard presets for civil, quarry & mining, microblasting, shot sleeping, misfire | None exist | Editor library: five empty slots, labelled "none supplied yet" |
| C14 | Risk rating scale | CCR-03, Risk Level Table never supplied | Rating column built and hidden |
| C15 | Hazard "owner" column | Not in any TEXC source | Built and hidden |
| C16 | Responsibility-matrix assignments | Operational content | Demo assignments are illustrative |
| C17 | Methodology presets beyond Chalmers Lane | None exist | Editor library: only the Chalmers eight-step method |
| C18 | Powder-factor unit; whether MIC and powder factor may be published at all | CCR-13; "never publish quantities" | Section 09 is off by default |
| C19 | Flyrock, dust, noise and monitoring wording | Operational content | Demo uses Chalmers Lane controls only |
| C20 | Generic logistics commitments | Drawn from `services.ts`; need sign-off as proposal lines. The Explosives Logistics safety line also says "Generic imagery does not imply ownership…", which reads oddly in a proposal | Section 13 (off by default) |
| C21 | Workflow diagram; Transfer Note vs Load Manifest; which suite document belongs to which stage | Source is "Draft — not approved"; CCR-06 | Section 12, off by default (on in the demo so it can be reviewed) |
| C22 | TEXC12 as a deliverable | Draft awaiting TEXC approval | Never offered |
| C23 | Remote Area Operations, Marine & Coastal | `pending: true` on the website | Never offered |
| C24 | Document-type labels (Shotfiring Proposal / Preliminary Proposal / Variation / Relief Cover Proposal) | From the brief only | Cover kicker |
| C25 | Acceptance legal wording; signature type. HP1 line adapted from "Approval of this preliminary assessment" to "Acceptance of the quotation and preliminary risk assessment" | Adviser wording; register notes a signature block "changes who is on the hook" | Section 19 |
| C30 | Reusing website copy (About, capability strip, values) inside proposals | Approved for the website only | Section 04 |
| C32 | "Labour-only (no equipment supplied)" vs MPU "equipment provision is confirmed on enquiry" | Prototype vs `services.ts` | Not used |
| C33 | Chalmers Lane–derived wording approved for other clients | Beardwood-specific source | Demo, and every Chalmers preset in the editor library (each insert must be acknowledged) |
| C35 | 000 emergency line, adapted "This website" → "This proposal" | `pages.ts contact.emergency` | Section 18 |
| C37 | Preliminary status line adapted "This document" → "This proposal" | Chalmers Lane callout | Section 18 and the callout in 05 |

## Decisions and set-up — Brand in Black

| # | Item | Status |
|---|---|---|
| C26 | Basement Grotesque licence covering this property | Open. Labels and body run on a fallback stack until confirmed; screenshots are labelled as fallback |
| C27 | Domain (`proposals.texc.au`?), sender address, SPF/DKIM | Open |
| C28 | Staff accounts and roles | Open |
| C29 | Default cover photo: TEXC-own only; `civil-blast-pattern` shows houses in the full frame and is not used | Demo uses `quarry-dusk-wide` |
| C31 | Privacy notice for proposals: acceptance now stores the name, position, company and email typed, the signature, a keyed hash of the connection, the device family, and requests for changes | Open — **needed before the first live acceptance** |
| C34 | Confirm texc.au is still aliased to deployment `33e8068` (one browser check of `/team/`) | Open |
| Q2 | Repository `Creeeds91/texc-proposals` | Done 13 Oct 2026 — created by Jesse, private |
| D2 | Supabase project (Sydney, paid plan), Vercel project, and the variables in `.env.example` — VAULT_KEY kept offline as well | Needed before the first deployment. Approval to create paid services is Jesse's |
| D3 | `img-src` allows `https://*.supabase.co` until the project exists | Narrow to the project's own origin in `lib/csp.js` and `vercel.json` at first deployment |
| D1 | Only deliberate static files may be public. `lib/editor-html.js` carries the editor and its library (Chalmers presets, prototype rates); `content/` and `fixtures/` must not be served either. Whether Vercel serves `lib/` from the repo root was not confirmed from its docs | Built: Vercel serves only `public/` (an explicit list written by the build). Still to prove on the first preview deployment: `/lib/editor-html.js` and `/content/library.seed.json` return 404 |
| D4 | Hosted Supabase Storage, from a browser: a PUT to a signed upload URL (raw body, `Content-Type: application/pdf`, no key), a CORS fetch of a signed download URL, and `&download=<name>` naming the file. All three hold against the local stand-in, which mimics the documented behaviour | Prove on the first preview deployment: attach, view and download one document |
| D5 | Vercel serves `/assets/vendor/` with `WORKER_CSP` and the pdf.js worker runs under it (if a browser applies the page's policy to the worker instead, pdf.js falls back to plain scripts for JPEG 2000 and colour) | Prove on the first preview deployment: open a document, no CSP errors in the console |
| Q7 | Online acceptance before T&Cs; signature type; adviser wording | Built as recommended: acceptance works without T&Cs (the sentence leaves terms out), drawn or typed signature (per proposal). **The adviser's wording (C25) is still needed before the first live proposal** |
| C38 | Wording drafted by Brand in Black for acceptance, not yet approved by TEXC: "Planning and site preparation can begin once this is accepted", "Hold point HP1 is met", the request-changes form, the acceptance and changes emails, and the acceptance record's headings | Open — TEXC to approve before the first live proposal |
| C39 | Dashboard defaults chosen by Brand in Black: follow-up after 5 days unopened, 3 days quiet, 7 days before valid-until; the archive reasons offered (did not go ahead, awarded to another contractor, work completed, duplicate or sent in error, practice or test, something else); the financial year as the default period | Open — George to confirm or change (each is one line in `assets/js/lifecycle.js` or `assets/js/dashboard.js`) |
| Q6 | Malware scanning | Option A built (staff-only uploads plus the structural check). Option B (ClamAV in Sydney) only if clients ever upload |
| Q4–Q15 | See `docs/architecture.md` §10. Recommendations were approved with the plan | Approved as recommended |

## Phase 6 notes

- **Signing in now lands on the dashboard.** The editor is one click away (Editor, or New proposal); the editor's list has a way back.
- **Archiving is not withdrawing, and not deleting.** It files a proposal away with a reason. While archived its link does not open for the client, and nothing can be changed or published on it; Restore undoes all of that. Withdraw (administrators, in the editor) is still how a proposal is taken back from a client on purpose.
- **Win rate is "of what we sent in the period, how much has been accepted so far"**, leaving out withdrawn proposals. Recent periods read low until clients have had time to decide.
- **Values are ex GST and priced items only.** Items "at cost" have no amount to add.
- **Practice proposals**: an administrator can mark one so it never counts in the figures or follow-ups (for training, or a test sent to ourselves).
- **The CSV export is recorded** (who, when, which filters, how many rows). It holds client names and contacts: treat a downloaded copy as TEXC's business records.
- **Purging** an archived proposal (super only, 90 days after archive) is Phase 7.

## Phase 5 notes

- **The fingerprint is the proof.** A client can only accept the exact text that was published: the page hashes the bytes it decrypted and the server compares them with the revision's. An acceptance record shows both fingerprints.
- **Only the current revision can be accepted.** Earlier ones open (marked superseded) and show their acceptance if they had one. Publishing over an accepted revision asks for an acknowledgement first, and the client is then asked to accept again.
- **Recording an acceptance by hand** (an emailed or signed copy) is for administrators, needs a note, is audited, and cannot be undone — as a client's acceptance cannot. A mistaken one is a matter for a later revision, and for the record to show it.
- **A drawn signature cannot be made from a keyboard.** Proposals default to "drawn or typed"; choose "drawn only" knowing it excludes keyboard-only users.
- **Valid-until vs link expiry.** Acceptance is open while the link is (valid-until + 30 days, C2). Whether TEXC wants acceptance to close at valid-until itself is a decision for them.
- **Emails go to the office (NOTIFY_TO, NOTIFY_BCC) and the person accepting.** The sender domain still needs SPF/DKIM (C27) before these reach inboxes reliably.

## Phase 4 notes

- **TEXC's own suite PDFs are refused as issued.** Eight of the twelve carry Acrobat calculation scripts. Attach a flattened copy: open the PDF and print it to PDF (Acrobat, Preview or Chrome all do). The flattened copy keeps every page and its look; the form can no longer be filled in on screen, which is right for a document sent with a proposal. TEXC03, TEXC05, TEXC10 and TEXC11 carry no scripts and pass as issued.
- **Up to 20 files per proposal, 25 MB each.** Both are settings in code (`lib/attachments.js`, the bucket in `supabase/schema.sql`).
- **Releasing a file** (administrators only) needs a sentence saying why it is safe to send; the reason, who released it and what the check found go into the staff audit, and the card and the checklist keep pointing it out. A file that is not a PDF, is encrypted, or is a "zip bomb" can never be released and is not kept.
- **Removing a file from a card** does not delete it: an issued revision may still offer it. Files stay with the proposal (archive and purge are Phase 6/7).
- **On a phone, a landscape form is small in the viewer.** Open in new tab gives the phone's own viewer, with pinch zoom. Zoom controls in the viewer can come in Phase 7 if George wants them.
- **The demo's documents** (Ashgrove Civil, fictional) have no files; publishing it needs a file on each client-visible card, which is correct. The Phase 4 captures attach two of TEXC's own forms by their register names and codes.

## Phase 3 notes

- **Link expiry is valid-until + 30 days** (`LINK_GRACE_DAYS` in `lib/proposals.js`) until TEXC sets a period (C2). The publish result shows the date.
- **The passphrase is shown once.** On first publish, with Copy; afterwards only by an administrator's read-back, which is recorded before it is shown. Every revision behind a link uses the same passphrase. "New link and passphrase" makes both new at once and kills the old link immediately.
- **Clients can open earlier revisions** (Q4), from the footer, marked superseded with a link to the current one. A withdrawn proposal opens for nobody.
- **The office is told on the first open** (NOTIFY_TO). The link email to the client never carries the passphrase.
- **Online acceptance is Phase 5.** Until then an issued proposal's acceptance form says to accept by email or phone. (Attachments, which said "available on request" here, open from Phase 4.)
- **Access**: anyone on an allowed domain (ACCOUNT_DOMAINS, default the website's domain) can ask from the sign-in page; administrators approve in People. Brand in Black accounts come from ACCOUNT_SUPERS and cannot be created or changed in the app. The staff list and roles are still to come from TEXC (C28).

### Independent security review (13 Oct 2026)

A read-only review of the Phase 3 server found nine confirmed issues; all are fixed and each now has a test in `check.mjs refusals`:

1. Publishing with an unlocked safety line committed, then crashed before showing the passphrase (the audit call had no request). Fixed; the unlocked publish completes and is audited.
2. Safety-line unlocks were administrator-only in the browser but not on the server. Now the server refuses them below administrator and stamps the administrator's own address.
3. The frozen website data carried George's full competency and licence lists. Now only name, role, biography and the licence note.
4. An editor could re-publish a withdrawn proposal and revive its old link. Now only an administrator can, and it gets a new link and passphrase.
5. Sign-in code guessing was a rate, not a cap. Now five wrong guesses throw the code away, with a daily cap per address.
6. Sign-in timing could hint which addresses have accounts. Every "email me a code" answer now takes the same minimum time.
7. A Brand in Black row was stored as an administrator. It now carries no standing of its own; the super tier is computed every time.
8. Access requests could be flooded. Capped system-wide per day.
9. The editor could conflict with its own save. Saves are now strictly one at a time.

Also: the vault's claim was corrected (drafts and published text are plaintext on the server; `docs/data-handling.md`), the private buckets are declared in `schema.sql`, the public demo fixture is stripped of editor notes, attachments are filtered by visibility in the projection, and rotation re-wraps keys in parallel.

## Phase 2 notes

- **Drafts** (Phase 3: now on the server). Autosave runs 2 s after typing stops and never more than 20 s while changes wait; a colleague's newer save is never overwritten without a choice. Photographs are resized in the browser (EXIF and GPS dropped) and stored in the private bucket.
- **The library is seeded, not managed.** `content/library.seed.json` holds the Chalmers Lane presets (hazards, eight-step method, HP1–HP5, site conditions, constraints, risk introduction and review), the status callout, the 13 responsibility-matrix items, prototype rates and terms (C1) and the letter template (C12). Five job types have empty hazard slots (C13). Editing the library in the app, and storing it in `texc_settings`, arrives with Phase 3.
- **Unlocking a compliance line** (a website `safety` line) is for administrators only, records the signed-in administrator, and such a proposal can only be published by an administrator (recorded in the staff audit).
- **Empty rows block publishing.** An added-but-blank row, a hazard without its control, a photograph row with no image and a limit with no source each block, because each would print as an empty card or cell.
- **A new photograph starts with no alt text or credit.** The previous ones described a different image.
- **Marking a field CONFIRM keeps its text** as the suggestion; "Confirmed — use this text" restores it.
- **Publishing** (Phase 3: now live) is in the checklist, with the section-by-section comparison against the previous revision.

## Phase 1 notes

- **Print footer.** The running footer (reference · revision · entity · ABN · page n of m) prints on every page in Chromium-based browsers, which print `@page` margin boxes. Safari and Firefox print it once, at the end. A server-side PDF (later phase) makes it universal.
- **A Chromium crash found and avoided.** Inserting an `@page` rule through the CSSOM, then reading it back, crashes Chromium's renderer. The footer is driven by a root custom property instead (`assets/js/proposal.js`, `setPrintFooter`).
- **Workflow is HTML, not SVG.** The brief asked for an inline SVG diagram. An ordered list styled as a chain reads in order for screen readers and reflows at phone width. Same content, verbatim.

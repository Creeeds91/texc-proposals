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
| C31 | Privacy notice for proposals (names, emails, signatures, hashed IPs) | Open, Phase 5 |
| C34 | Confirm texc.au is still aliased to deployment `33e8068` (one browser check of `/team/`) | Open |
| Q2 | Repository `Creeeds91/texc-proposals` | Done 13 Oct 2026 — created by Jesse, private |
| D1 | Only deliberate static files may be public. `lib/editor-html.js` carries the editor and its library (Chalmers presets, prototype rates); `content/` and `fixtures/` must not be served either. Whether Vercel serves `lib/` from the repo root was not confirmed from its docs | Phase 3: serve static files from an explicit output folder, and prove on the first preview deployment that `/lib/editor-html.js` and `/content/library.seed.json` return 404 |
| Q4–Q15 | See `docs/architecture.md` §10. Recommendations were approved with the plan | Approved as recommended |

## Phase 2 notes

- **Drafts live in one browser until Phase 3.** Autosave (2 s after typing stops, never more than 20 s while changes wait) writes to that browser's storage; uploaded photographs are resized there (EXIF and GPS dropped) and kept in its database. Export a draft as `.json` to move it or keep a copy. Phase 3 moves drafts to the server with a version check, so two people cannot overwrite each other silently.
- **The library is seeded, not managed.** `content/library.seed.json` holds the Chalmers Lane presets (hazards, eight-step method, HP1–HP5, site conditions, constraints, risk introduction and review), the status callout, the 13 responsibility-matrix items, prototype rates and terms (C1) and the letter template (C12). Five job types have empty hazard slots (C13). Editing the library in the app, and storing it in `texc_settings`, arrives with Phase 3.
- **Unlocking a compliance line** (a website `safety` line) asks for a name and records it on the proposal. Until accounts exist (Phase 3) that name is typed, not signed in — the Phase 3 build ties it to the signed-in admin and writes it to the audit log.
- **Empty rows block publishing.** An added-but-blank row, a hazard without its control, a photograph row with no image and a limit with no source each block, because each would print as an empty card or cell.
- **A new photograph starts with no alt text or credit.** The previous ones described a different image.
- **Marking a field CONFIRM keeps its text** as the suggestion; "Confirmed — use this text" restores it.
- **Publishing is visible but disabled** in the checklist until Phase 3. So is the comparison with the previous revision.

## Phase 1 notes

- **Print footer.** The running footer (reference · revision · entity · ABN · page n of m) prints on every page in Chromium-based browsers, which print `@page` margin boxes. Safari and Firefox print it once, at the end. A server-side PDF (later phase) makes it universal.
- **A Chromium crash found and avoided.** Inserting an `@page` rule through the CSSOM, then reading it back, crashes Chromium's renderer. The footer is driven by a root custom property instead (`assets/js/proposal.js`, `setPrintFooter`).
- **Workflow is HTML, not SVG.** The brief asked for an inline SVG diagram. An ordered list styled as a chain reads in order for screen readers and reflows at phone width. Same content, verbatim.

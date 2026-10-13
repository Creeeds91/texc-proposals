# TEXC Proposals — architecture (approved Phase 0 plan)

> Approved 13 Oct 2026 ("approved create the repo and start phase 1"). This is the Phase 0 plan as approved; where the build has since refined it, the code and docs/open-items.md say so.

> **Side fix, done 12 Oct 2026 (not part of this job):** the texc.au mega menu's missing "All services →" link is fixed in commit `4d5cb26` on branch `claude/new-session-c7n8dz` of `Creeeds91/texc`.

Shotfiring proposal system for TEXC Pty Ltd ("TEXC IAP"). Prepared 12 Oct 2026 from a full read of `Creeeds91/roberts` @ `900f1dd`, `Creeeds91/texc` @ `33e8068`, the TEXC design-system artifact and the brief. Reviewed once by an independent pass. **No code has been written.**

---

## 0. Context, scope and what changes from the brief

**Why this exists.** TEXC sends prospective clients (civil contractors, quarries, mines, builders) a shotfiring proposal for each engagement. Today that is a hand-built document, as for 2 Chalmers Lane. The goal is a long-scrolling, password-gated web proposal:
- staff build it in an editor with a live preview
- clients read it, open the PDFs and accept it online
- every revision is archived and reported on

The functional blueprint is the Roberts IAP; the look is texc.au.

**Tier.** **Bespoke.** It has a database, staff accounts, file uploads, signatures and an archive. `texc/docs/spec.md` lists Client Portal and file upload as out of the website's scope. `documents/process/digital-path.md` calls any digital system "a separate conversation before any of it is built". It needs its own quote and BIB number (Q1). The rough size is about 126–188h, see §9.

**Findings that change the brief** (each is reflected below):

1. **TEXC's own suite PDFs carry JavaScript.** The Acrobat calculations in 9 of the 12 exemplars are JavaScript, so a "reject `/JS`" rule blocks the very documents §12 of the brief offers. Fix: attach flattened (printed-to-PDF) copies, plus an audited admin override.
2. **No risk ratings exist.** Chalmers Lane has Hazard and Preliminary Control only. The suite's Risk Level Table was never supplied (**CCR-03**). Rating and owner columns are built but hidden.
3. **Two listed services are not offered.** Remote Area Operations and Marine & Coastal are `pending: true` ("No remote area capability is offered or implied"). They are excluded from the picker.
4. **One preset exists, and it is Beardwood-specific.** Chalmers Lane is the only hazard and method preset anywhere. It ships verbatim with the client name tokenised, marked CONFIRM until George approves reuse. The other four job types are empty CONFIRM slots.

**Deliberate deviations from the brief, and why:**

| Brief | Plan | Why |
|---|---|---|
| SJCL, 310k PBKDF2 | **WebCrypto** PBKDF2-SHA256 (600k) + AES-256-GCM; no SJCL | SJCL runs on the main thread, about 1.4s on a desktop at 310k (`editor-sales.js:903`), so several seconds of frozen "Unlocking…" on an older iPhone. WebCrypto is native and async. A new system needs no Roberts compatibility. |
| Staff browser encrypts | **Server encrypts at publish**, from a server-built projection | One authority produces the exact published bytes. Their hash is what the client later proves it read, and the quote snapshot and CONFIRM check derive from the same bytes. Hidden sections and editor notes never enter the client's copy. |
| Per-revision attachment paths | Content-addressed paths; the revision binds files by snapshot | A file is uploaded before its revision exists. |
| Hazard residual-rating chips | Built, hidden until CCR-03 | Would be invented content. |
| Workflow SVG in §12 | Built, off by default | Its source is "Draft — not approved"; CCR-06 is open. |
| Large button 46px | 44px | That is production (`Button.tsx`). Production wins. |
| Oxanium from Google Fonts | Self-hosted (OFL permits) | One less third party on a page holding decrypted content; simpler CSP. |
| Per-revision links | One link and passphrase per proposal; revisions behind it | Never breaks a live link (Roberts covenant). The superseded banner can always link to the current revision. |

---

## 1. Architecture: one page

**Shape.**
- A new private repo, `Creeeds91/texc-proposals`.
- A **port, not a fork** of Roberts. The fork plan's delete list would break Roberts' build, which now depends on `tools/`, and TEXC's model differs too much for cherry-picks. Each ported file carries a provenance line (Roberts file and SHA).
- Vercel, functions pinned to `syd1`.
- Its own Supabase project in `ap-southeast-2` (`roberts/docs/new-iap-type.md`, "Separate"; `own-database-runbook.md`).
- Zero npm runtime dependencies.
- Supabase is reached only server-side, via PostgREST and Storage REST with the secret key.
- Three **private** buckets with `file_size_limit` and `allowed_mime_types` set: `texc-media`, `texc-attachments`, `texc-acceptances`.

**Surfaces.**

| URL | What | Gate |
|---|---|---|
| `/p/<slug>?t=<token>` | Client proposal (static `views/proposal.html`) | Link token, then passphrase decrypts in the browser |
| `/editor`, `/editor/<id>` | Same template plus the editor drawer, served as a string by `api/editor.js` | Staff session (editor or admin) |
| `/dashboard` | Archive and reporting | Staff session (any role) |
| `/signin` | One-time code or link (Roberts `iap-accounts.js`) | Public |
| `/staff/acceptance/<id>` | Stored acceptance record | Staff session |

**Publish pipeline** (one source of truth for what the client sees):
1. The draft (plaintext `jsonb`) goes through `toPublished(draft)`, an allowlist projection that:
   - drops hidden sections, editor notes and `$confirm` objects
   - injects the locked lines and the texc.au snapshot verbatim
   - adds the template version
2. It is refused if any visible field was a `$confirm`, any sensitive-pattern warning is unacknowledged, or the quote fails to reconcile.
3. It is serialised once to UTF-8 bytes, `published_text`, and `plaintext_sha256` is taken.
4. It is encrypted (PBKDF2-SHA256 600k, AES-256-GCM, fresh salt and IV) under the proposal passphrase. The envelope is `{v,kdf,iter,salt,iv,ct}`.
5. The `texc_publish()` RPC writes everything in **one transaction** with the proposal row locked:
   - allocate the reference on first issue
   - insert the revision
   - supersede the previous one
   - repoint `current_revision_id`
   - write the event

The client fetches the envelope, decrypts with WebCrypto, **hashes the plaintext bytes before `JSON.parse`**, and keeps that hash for acceptance.

**Carried over from Roberts, in principle:**
- The template contract: `data-field`, `data-empty`, `data-img`, `data-crop`, clone-first-row repeaters, `data-reveal`, `data-sec`.
- The runtime exports `applyConfig`, `initEffects`, `whenImagesReady`. An absent key means the built-in default.
- The editor is a build-time JS string behind auth; the build fails on any editor-code leak into the view.
- `passphrase.js` (about 50 bits).
- A 64-hex link token, plus a view token sealed in the encrypted config.
- Uniform 410; 204 for record-only endpoints; `rate_hit` keyed by an HMAC'd IP; `refuseCrossSite()`; scrypt with `timingSafeEqual`; atomic claims; fail-closed reads before writes.
- No `console.*`, no `select=*`, noindex.
- RLS on with zero policies. Idempotent `schema.sql`; column order is load-bearing; restore by column name.
- `lib/brand.js` plus `brand-check`.

**New, and closing the gaps Roberts' own review records:**

| Roberts gap | TEXC design |
|---|---|
| `enc` overwritten in place | Immutable revisions. Triggers refuse UPDATE, DELETE and TRUNCATE on content columns. `superseded_at` and `withdrawn_at` can be set once only. |
| Multi-write publish and accept | `texc_publish()`, `texc_accept()` and `texc_mark_accepted()`: security-definer RPCs in one transaction with a row lock. |
| No per-proposal archive | `archived_at` / restore per proposal. Hard delete only via `texc_purge()` (super only, 90 days after archive, audited; a transaction-local flag is the only thing the triggers let through). |
| Click-only acceptance | Full HP1 capture (§6), server-recomputed total, plaintext fingerprint, signature in a private bucket, stored acceptance record. |
| No CSP on the client page; inline gate | No inline script or style anywhere in the views. Strict CSP, `frame-ancestors 'none'`, XFO DENY, nosniff, `Referrer-Policy: no-referrer`, minimal `Permissions-Policy`, `X-Robots-Tag: noindex, nofollow`. |
| Public image bucket | Private. After unlock, one batch call returns 1-hour signed URLs (`POST /storage/v1/object/sign/<bucket>` with `{paths}`). |
| Explicit save only | Autosave: debounced, with a guaranteed save within 20s while dirty; integer `version` conflict check. |
| No `beforeprint` | Print CSS reveals everything with no JS. "Download PDF" pre-loads every image, refreshes links, awaits `whenImagesReady()`, then calls `print()`. |
| Plaintext password in localStorage 24h | Nothing persisted. The derived key lives only in memory for the tab. |
| Accept 404/403; `select=*` and DB text echoed on staff routes | Uniform 410. `check.mjs` suite `conventions` fails on `console.*`, `select=*` or echoed DB errors. |
| No link rotation (Roberts has `reissue.js`) | Admin "Rotate link and passphrase", and admin passphrase read-back. Both are audited and rate-limited. |

**Back-compat.**
- Each revision stores `template_version` and its own fully-baked `published_text`, so a later website or library edit never alters an issued proposal.
- A design change that would alter an old revision ships as template v2 alongside v1. A screenshot design-lock check is added then, not before.

**CONFIRM can never reach a client.**
- An unconfirmed value is `{"$confirm":"what is needed"}`, never a string.
- In the editor it renders as a red tag.
- The server projection refuses publish while any visible field holds one.
- The published bytes are scanned for the literal text `CONFIRM` as a final guard.
- "To be agreed" is a separate, deliberate published value.

---

## 2. File tree (target repo)

```
texc-proposals/
  CLAUDE.md  README.md  package.json (dependencies: {})  vercel.json  robots.txt (Disallow: /)
  .env.example  .gitignore  .vercelignore
  api/        proposal.js  view.js  event.js  media.js  attachment.js  accept.js  changes.js      ← client: uniform 410 / 204
              auth.js  signin.js  editor.js  dashboard.js                                       ← staff pages
              proposals.js (create/duplicate/new-rev/archive/restore/withdraw/rotate)  drafts.js
              publish.js  media-upload.js  attachment-upload.js  attachment-verify.js
              attachment-admin.js  mark-accepted.js  analytics.js  export.js  settings.js
              people.js  acceptance-record.js
  lib/        brand.js  db.js  links.js  ratelimit.js  accounts.js  events.js  notify-email.js
              storage.js  envelope.js (PBKDF2+AES-GCM)  projection.js (toPublished)  pdf-inspect.js
              money.js  vault.js (passphrase at rest)  csp.js  library.js  sensitive.js
              editor-html.js  dashboard-html.js  signin-html.js     ← generated by build
  templates/  proposal.html  dashboard.html  signin.html  acceptance-record.html  privacy.html
  assets/
    css/      tokens.css  proposal.css  print.css  editor.css  dashboard.css
    js/       proposal.js (runtime)  gate.js (WebCrypto)  passphrase.js  money.js (shared with server)
              editor/{core,panels,rows,media,attachments,library,checklist,publish}.js
              signature.js  pdf-viewer.js  dashboard.js
    vendor/   pdfjs/<pinned>/ (build, standard_fonts, cmaps, wasm, iccs)  ← lazy-loaded
    fonts/    Oxanium-800.woff2 (OFL); Basement Grotesque only after licence (Q13)
    img/      logo/TEXC-{Gold,White,Black}.svg (repaired copies); TEXC-own photos only
  content/    texc-snapshot.json (generated)  locked-lines.json  library.seed.json  workflow.json
  fixtures/   demo-proposal.json  demo-proposal-revB.json   ← fictional client and site
  views/      proposal.html  (generated)
  supabase/   schema.sql
  scripts/    build.mjs  check.mjs (suites: contract, brand, csp, conventions, confirm, quote,
              refusals, attachments, print, content-sync)  schema-standup-check.mjs
              security/rls-proof.mjs  texc-content-sync.mjs  demo/local-app.mjs  demo/capture.mjs
  docs/       architecture.md  open-items.md  data-handling.md  attachments.md  editor-guide.md
```

**Ported from Roberts, adapted:**
- `lib/`: `iap-db.js`, `iap-links.js`, `iap-ratelimit.js`, `iap-accounts.js`, `iap-events.js`, `notify-email.js` (SMTP2GO with Resend fallback), `brand.js`.
- `api/`: `auth.js`, `signin.js`, `proposal.js`, `proposal-view.js`, `iap-event.js`, `mark-accepted.js`, `analytics.js`, `link-status.js`, `reissue.js`.
- `assets/js/`: `passphrase.js`, `drawer.js`.
- `scripts/`: `schema-standup-check.mjs`, `security/rls-proof.mjs`, and the contract, brand, ip-hash, accounts and staff-throttle checks (folded into `check.mjs` suites), `demo/local-app.mjs`.

**`texc-content-sync.mjs`:**
- Imports `../texc/content/{site,services,pages}.ts` using Node type stripping plus a six-line `module.registerHooks` resolver for `pages.ts`'s extensionless `./site` import (tested; Node ≥22.15).
- Writes `content/texc-snapshot.json` and compares `tokens.css` against `globals.css`.
- `--check` fails when stale, and exits 3 ("not checked") when the sibling clone is absent, the Roberts convention.

---

## 3. Client page: section map and field keys

Conventions:
- A key is the config path (`data-field="meta.project"`).
- **L** = locked line from `content/locked-lines.json`; an admin unlock is logged.
- **S** = texc.au snapshot, baked in at publish.
- **C** = CONFIRM until supplied.
- **Req** = blocks publish.

Order is `cfg.layout.sections: [{id,on}]`. Cover is pinned first, Acceptance and Contact last; the rest reorder. Numbers (01…) follow the visible order.

**Furniture** (not sections):
- Top bar: logo, `meta.project`, "Prepared for {client.company}".
- 3px gold scroll-progress bar.
- Numbered side index; a bottom sheet at 390px.
- Back-to-top.
- Status chip.
- Superseded banner.
- Footer: `{reference} · REV {rev} · TEXC PTY LTD · ABN …` (from `brand.js`).

| # | `data-sec` | Field keys | Source, default and rules |
|---|---|---|---|
| 01 | `cover` | `meta.docType` (shotfiring / preliminary / variation / relief-cover), `meta.project` Req, `meta.siteLocality` Req, `meta.siteRegion`, `client.company` Req, `client.contactName` Req, `client.contactPosition`, `client.email` Req (staff only, not rendered), `meta.reference` (server), `meta.rev` (server), `meta.issueDate` (at publish), `meta.validUntil` Req, `meta.preparedBy`, `cover.image{id,alt,crop{x,y,s},credit}` (alt Req) | Region enum from `pages.ts request.regions`. Locality is suburb and region only; the editor warns on coordinates or street numbers. Default cover is a TEXC-own photo, never `stock-*` (C29). The chip uses TEXC's own status wording (C10). |
| 02 | `letter` | `letter.greetingName` (defaults to the first word of the contact name), `letter.body[]`, `letter.signoffName`, `letter.signoffRole`, `letter.portrait{id,alt}` | Sign-off "Regards, George Scott — TEXC Pty Ltd". Role "Managing Director \| Licensed Shotfirer" (S). Body drafted in TEXC voice, C until approved (C12). |
| 03 | `glance` | Derived. Optional `glance.startText`, `glance.durationText`, `glance.leadTimeText` | Services, site, start, duration, lead time, total ex GST, valid until, hold points outstanding, CTA to `#accept`. |
| 04 | `about` | `about.on` | S: `about.support.body` and `.quote`, `capabilityStrip[5]` (`site.ts`), `about.working.steps[4]`. |
| 05 | `understanding` | `understanding.paras[]` (`**bold**`), `understanding.photos[]{id,title,caption,credit,alt}` (max 6), `understanding.sitePlan{id,alt,caption}`, `understanding.callout{lead,text}` | Real project imagery only. Credit: TEXC photo / Client photo / other. Site-plan label "APPROVED PROJECT MAP — DO NOT REDRAW" (L). Callout defaults to the Chalmers "Preliminary status:" text. |
| 06 | `scope` | `scope.services[]{slug,name,scopeText[],safety,safetyUnlockedBy}`, `scope.inclusions[]`, `scope.exclusions[]`, `scope.matrix[]{item,party,note}`, `scope.note` | 11 live services only. Selecting one inserts `overview[]` (editable) and `safety` (L). `scope.note` is L (`servicesPage.scopeNote`). The matrix has the brief's 13 rows; `party` (texc \| client \| shared \| to-be-agreed) starts as C, so staff must choose each (Q15). |
| 07 | `site` | `site.meta[]{label,value}` (Site, Region, Access, Terrain, Nearest structures / receptors, Services, Environmental controls), `site.conditions[]`, `site.photos[]` (max 3), `site.constraints[]{constraint,intent}` | Qualitative; no distance field. Sensitive-pattern warnings apply. |
| 08 | `method` | `method.intro`, `method.steps[]{title,detail}`, `method.callouts[]{lead,text}` | Preset: the Chalmers 8 steps verbatim with `{client}` (C33). "Progressively rather than as a single unrestricted blast" offered as a callout. |
| 09 | `params` (off) | `params.rows.{holesPerShot,shots,holeDiameter,depthRange,burdenSpacing,stemming,initiation,mic,powderFactor,containment}{value,tbc}` | No defaults; "TBC in final blast design". Initiation: Non-El / Electronic / TBC. Powder-factor unit C (CCR-13). L: "Parameters are preliminary and indicative only. This proposal is not a final blast design or authority to undertake blasting." **Admin-only toggle** (Q9). |
| 10 | `env` | `env.monitoring`, `env.locations[]`, `env.limits{note,rows[]{parameter,limit,source}}`, `env.controls[]{topic,text}`, `env.neighbours` | L: "Limits as set by the site approval / regulator — supplied by client". `source` is Req on every limit row. The monitoring default is TEXC's workflow stage-7 list. Controls C (C19). |
| 11 | `risk` | `risk.intro[]`, `risk.hazards[]{hazard,control,rating,owner}`, `risk.holdPoints[]{code,title,requirement,status: open\|met\|na}`, `risk.review[]` | Chalmers wording verbatim with `{client}`. "No blasting activity will proceed until…" (L). `rating` hidden (CCR-03); `owner` optional, blank (C15). |
| 12 | `docs` | `docs.items[]{id: TEXC01…TEXC11,provide,note}`, `docs.projectDocs[]{title,note}`, `docs.workflow.on` | Names and codes exactly from `register.md`. TEXC12 hidden (draft). Workflow SVG uses TEXC's 8 stages verbatim, off by default (C21). |
| 13 | `logistics` (off) | `logistics.on`, `logistics.commitments[]` | Chosen from L generic lines only (from `services.ts`). **No free text, deliberately** (C36). Editor banner carries the security rule. |
| 14 | `team` | `team.people[]{personId,name,role,photo{id,alt},competencies[]{text,confirmed}}`, `team.evidence[]{attachmentId,label}` | People come from the library (S, `team.people`). Only confirmed competencies render (C5). Evidence is an attachment marked `visibility: on-request` (a card saying "Available on request", no file access) or `client`. Policy line (L): "Competency sits with the person doing the work." plus `capability.competency.body`. |
| 15 | `programme` | `programme.start`, `.finish`, `.duration`, `.shiftPattern`, `.leadTime`, `.phases[]{name,start,end,holdPoint}`, `.dependencies[]` | Timeline bar with HP markers from `risk.holdPoints`. `en-AU` dates. |
| 16 | `quote` | `quote.lines[]{id,desc,basis,qtyHundredths,unit,rateCents,optional,optionalDefault}`, `quote.terms{minimum,standby,travel,mobilisation,invoicing,payment}`, `quote.assumptions[]`, `quote.exclusions[]` | Basis: hourly / daily / per-shift / lump-sum / at-cost / provisional-sum. Integer maths, half-up per line, GST 10% once on the subtotal. `money.js` is shared with the server. **All presets C** (C1, C2). Optional ticks update the total live (`aria-live`). |
| 17 | `attachments` | `attachments[]{id,title,category,pages,bytes,docRev,docDate,docCode,visibility: client\|on-request}` | Snapshot at publish. Groups: Project documents / Risk & compliance / Drawings & plans / Certificates & insurance / Other. pdf.js modal, plus Open in new tab and Download. |
| 18 | `terms` | `terms.version`, `terms.body[]` | Body C (C3). L lines: preliminary status; insurance (`safety.assurance.body` verbatim); misfire line (C11); 000 emergency line (`contact.emergency`, C35). Collapsible; print expands it. |
| 19 | `accept` | `accept.signature` (drawn / typed / both), `accept.optionsAllowed` | HP1 framing (L, Chalmers): "permits progression of planning and site preparation only and does not constitute unconditional authority to undertake blasting." See §6. |
| 20 | `contact` | none | `brand.js`: George's card (phone, mail, globe), entity, ABN, tagline in Oxanium caps, reference and revision, privacy link. |
| — | sealed | `__vt`, `v`, `template` | Only inside the encrypted envelope. `__vt` is never stored in plaintext; the DB holds `view_token_hash`. |

**Sensitive-pattern warnings** (warn, never block; acknowledged before publish):
- decimal or DMS coordinates
- "magazine at/located"
- a quantity in kg, t or tonnes near an explosives term
- plate-shaped strings
- "route", "via" or "depart" near a time
- Matching is on the decoded text.

---

## 4. Editor (staff)

**Layout.**
- Desktop: a left drawer over the live page (Roberts `drawer.js` mechanics).
- Phone: a full-screen sheet with an Edit / Preview toggle.
- Every input re-runs `applyConfig`.
- Panels follow §3, each with a show/hide toggle, a drag handle (keyboard Alt+↑/↓) and a completeness badge (required fields, CONFIRM count).

**Rows.** Add / duplicate / reorder / delete for every repeatable list in §3.

**Library** (`texc_settings`):
- Contents: scope per service, hazard and method presets, exclusions, assumptions, terms versions, rate presets.
- "Insert from library" copies into the draft; library edits never reach a published revision.
- Seeded from `content/library.seed.json`.

**Start points.**
- New from template.
- Duplicate: choose the sections to copy; never acceptance, events or scan overrides.
- New revision.

**Autosave.**
- Phase 2: `localStorage`.
- Phase 3: `PUT /api/drafts {config, version}`, debounced 2s with a guaranteed save within 20s while dirty, plus explicit Save.
- "Saved 12:04" is announced in `aria-live`.
- The server does a conditional PATCH on `version=eq.<n>` and bumps it. A miss returns 409 with who saved and when, and the banner offers "Load theirs" / "Keep mine and overwrite" (overwrite is audited).
- Draft bodies are capped at about 1 MB.

**Images.**
- Canvas downscale per slot, Roberts caps (cover 2000, photos 1400, portraits 1200, team 900).
- Each image is produced at **three widths** for `srcset`: WebP 0.82 where the browser encodes it, else JPEG 0.85.
- Crop/pan `{x,y,s}` as in Roberts.
- Uploaded by signed upload URL to `texc-media/proposals/<id>/media/<sha256[:16]>-<w>.<ext>`, never with `x-upsert`.
- Alt text is required.

**Pre-publish checklist** (blocking; the server re-checks every item):
- No CONFIRM in a visible section.
- Valid-until and client email set.
- Quote reconciles.
- Every client-visible attachment is clean, or overridden by an admin with a reason.
- Sensitive warnings acknowledged.
- Preliminary status line present.
- Section-by-section diff against the previous revision shown.

**Publish dialog.**
- The server generates the passphrase (wordlist from `passphrase.js`) on first issue and reuses it after that.
- Copy link, copy passphrase.
- Optional "email the link to the client". The passphrase is never in it; the UI says to give it by phone or SMS.
- Link expiry.
- Admins also get "Show passphrase" and "Rotate link and passphrase" (audited, rate-limited).

**Roles.** `admin` (George, TEXC management), `editor`, `viewer`, plus `super` (Brand in Black, from `ACCOUNT_SUPERS`).

---

## 5. Attachments (PDF)

**Upload.**
- `POST /api/attachment-upload` (editor role) returns a signed upload URL for `texc-attachments/proposals/<id>/attachments/<sha256[:16]>-<safe-name>.pdf`.
- The bucket itself caps size (25 MB) and type (`application/pdf`); 20 per proposal (setting).

**Verify** (`POST /api/attachment-verify`, dependency-free, fixed `maxDuration`):
- `%PDF-` magic bytes, size, and `/Encrypt` refused.
- SHA-256.
- Inflate FlateDecode streams with a per-stream `maxOutputLength` and a total budget (zip-bomb safe). Image filters (DCT/JPX/CCITT/JBIG2) are skipped, since they cannot hold objects.
- Decode `#xx` name escapes, then match.
- **Reject:** `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`, `/SubmitForm`, `/ImportData`.
- `/OpenAction` and `/AA` only when they point at one of those; a bare OpenAction just sets the zoom.
- An undecodable non-image stream returns `cannot-verify`.
- Page count and the first-page thumbnail come from pdf.js in the staff browser, cross-checked against the server's page-object count.

**TEXC suite PDFs.** Attach **flattened (printed-to-PDF) copies**, which carry no scripts. A logged admin override exists for exceptions.

**Malware scanning: decision (Q6).** Until it is decided, uploads are staff-only and `unscanned` blocks publish unless an admin overrides it with a reason. That answers `docs/spec.md` directly.

| Option | What | In Australia | Cost | Build |
|---|---|---|---|---|
| **A** (recommended now) | Staff-only uploads plus the structural checks above | Yes | $0 | Included |
| **B** (recommended if clients ever upload) | ClamAV in a scale-to-zero container (Cloud Run `australia-southeast1` or Fly `syd`) called by verify | Yes | Low, priced on choice | +6–10h, plus signature-update upkeep |

Ruled out: commercial scanning APIs (client drawings leave Australia) and AWS GuardDuty (adds an AWS account for one feature).

**Client access.**
- `POST /api/attachment {slug,t,vt,id}`. The view token is in the body, never the URL.
- Checks, in order: link token, then view token against `view_token_hash`, then that the id is in that revision's snapshot with `visibility: client`.
- Then it rate-limits, logs `attachment_opened`, and returns `{url}`: a **60-second** signed URL, with `download=` for Download.
- Any refusal is the identical 410.

**pdf.js** (pinned, self-hosted with `standard_fonts`, `cmaps`, `wasm`, `iccs`):
- Options: `isEvalSupported:false`, `disableRange:true`. One streamed request, so a slow 4G download outlives the 60s link.
- CSP: `worker-src 'self'`; `'wasm-unsafe-eval'` only on the viewer's worker if the pinned version needs it (else `useWasm:false`); `connect-src` and `img-src` include the Supabase origin.
- Canvas is not accessible, so Open and Download stay the accessible route, and the only one on old Android.

**Later.** The data model leaves room for "Generate from suite" (`source='suite'`, `source_ref`). Not built.

---

## 6. Acceptance (HP1)

**Panel.**
- Name, position, company (pre-filled, editable) and email.
- ☐ "I have authority to accept on behalf of {company}".
- ☐ "I accept the quotation, terms ({terms.version}) and preliminary risk assessment". The terms clause is omitted, and publish warns, while there are no T&Cs (Q7).
- Optional-item ticks carry over.
- Signature: drawn (a dependency-free canvas, about 2 KB, lazy-loaded) and/or typed.

**`POST /api/accept`, through `texc_accept()` in one transaction:**
1. Link token and view token, then rate limit.
2. The revision must be current, not withdrawn, and the link not expired.
3. The client sends the `plaintext_sha256` of the bytes it decrypted. It must equal the revision's, which proves it read exactly what was published.
4. The total is recomputed server-side from the revision's `quote_snapshot` and the chosen option ids.
5. **Claim:** `insert … on conflict (revision_id) do nothing`.
   - If the claim is won: upload the signature PNG (magic bytes, 200 KB cap) to `texc-acceptances` and attach the path.
   - **Double tap:** a valid view token and an existing acceptance return `200 {already:true}` with the existing record, not a 410.
6. Stored: name, position, company, email, both confirmations, signature ref, options, `accepted_total_cents`, terms version, `plaintext_sha256`, `enc_sha256`, the UTC timestamp (shown in `Australia/Hobart`), hashed IP and UA family.
7. Emails to George plus `NOTIFY_BCC` and to the accepter (reference, revision, total, HP2 next step). They ignore mute settings.
8. The **acceptance record** HTML is rendered and stored at acceptance time (`record_path`), so it can be printed to PDF from the archive.

**Re-acceptance.** A revision published after acceptance shows "Revised after acceptance — re-acceptance required"; HP1 resets for that revision only.

**Staff-recorded acceptance.** `texc_mark_accepted()` with a mandatory note, labelled "Recorded by staff".

**Request changes.** Free text (2,000 characters), logs `changes_requested`, emails George. No claim.

---

## 7. Data model (Supabase, Sydney, `supabase/schema.sql`)

Roberts rules apply:
- Idempotent; RLS on with zero policies.
- `revoke all … from anon, authenticated`; `revoke execute` on the functions.
- `touch_updated_at()`; UTC.
- Later columns appended with `alter table add column`.
- Generated columns are excluded from restore and column-order checks (COPY skips them).

| Table | Columns, in order |
|---|---|
| `texc_clients` | id uuid pk, name, abn, contact_name, contact_position, contact_email, contact_phone, notes, created_at, updated_at, archived_at |
| `texc_proposals` | id uuid pk, slug (10-char random, unique), reference (unique; null until first issue), client_id fk, project, site_locality, site_region, services text[], doc_type, status, current_revision_id, access_token (unique), passphrase_enc, issued_at, link_expires_at, valid_until date, value_cents bigint, first_opened_at, last_opened_at, open_count int, accepted_at, archived_at, archived_by, archive_reason, is_test bool, created_at, created_by, updated_at, search_extra text (client name, services, attachment titles; maintained by the app), search tsvector **generated** from `to_tsvector('simple', coalesce(reference,'')\|\|' '\|\|coalesce(project,'')\|\|' '\|\|coalesce(site_locality,'')\|\|' '\|\|coalesce(site_region,'')\|\|' '\|\|coalesce(search_extra,''))` |
| `texc_proposal_revisions` | id uuid pk, proposal_id fk, rev_index int, rev_label, enc text, enc_sha256, published_text text, plaintext_sha256, view_token_hash, template_version, quote_snapshot jsonb, terms_version, attachments_snapshot jsonb, change_note, published_at, published_by, superseded_at, withdrawn_at; unique (proposal_id, rev_index). **Immutable** except a set-once `superseded_at` / `withdrawn_at`. |
| `texc_drafts` | proposal_id pk fk, config jsonb, version int, base_revision_id, updated_at, updated_by |
| `texc_attachments` | id uuid pk, proposal_id fk, storage_path, original_name, title, category, description, doc_code, doc_rev, doc_date, sha256, bytes, pages, thumb_path, scan_status (pending\|clean\|rejected\|cannot-verify\|unscanned\|override), scan_detail jsonb, scanned_at, override_by, override_reason, visibility (client\|on-request\|staff), sort int, source (upload\|suite), source_ref, uploaded_by, created_at, archived_at |
| `texc_acceptances` | id uuid pk, proposal_id fk, revision_id fk **unique**, kind (client\|staff), accepted_at, name, position, company, email, authority_confirmed, terms_confirmed, terms_version, signature_kind, signature_path, typed_signature, options jsonb, accepted_total_cents, plaintext_sha256, enc_sha256, ip_hash, ua_family, recorded_by, staff_note, record_path, created_at. **Append-only.** |
| `texc_events` | id bigserial, proposal_id, revision_id, event, session, actor, meta jsonb, created_at. **Append-only.** |
| `texc_proposal_views` | id bigserial, proposal_id, revision_id, session, device (family), region (`x-vercel-ip-country-region`), created_at |
| `texc_settings` | key pk, value jsonb, updated_at, updated_by. Keys: `library.*`, `terms`, `notify`, `analytics_hidden`, `limits`, `client_can_view_superseded` |
| `texc_counters` | key pk, value int |
| `texc_rate_limits` + `texc_rate_hit()` | As Roberts |
| `texc_staff_audit` | As Roberts, plus target and detail jsonb. **Append-only.** |
| `texc_users`, `texc_login_tokens`, `texc_user_sessions` | As Roberts |

**Functions** (security definer, `search_path` pinned, execute revoked from anon and authenticated):
- `texc_publish(...)`
- `texc_accept(...)`
- `texc_mark_accepted(...)`
- `texc_next_reference(year)`
- `texc_search(q)`: cleans input into a prefix tsquery (`w:* & …`), and also matches `reference ilike`.
- `texc_purge(id)`: the only path through the immutability triggers, via a transaction-local flag.

**Lifecycle**, computed in `analytics`:

| State | Means |
|---|---|
| Draft | Never issued |
| Issued | Current revision published |
| Opened | At least one view |
| Engaged | An attachment opened, an option ticked, or 3+ sessions |
| Changes requested | Changes requested |
| Accepted | Current revision accepted |
| Superseded | Older revision |
| Withdrawn | Withdrawn by staff |
| Expired | `link_expires_at` or `valid_until` passed |
| Archived | `archived_at` set |

**Follow-up lists:** unopened 5+ days after issue; opened but not accepted, last open 3+ days ago; valid-until within 7 days. **Win rate** = accepted ÷ issued (excluding withdrawn and test) over the selected period.

**Proofs** (scratch database only, never production):
- `schema-standup-check.mjs` (run twice; RLS; anon probes; the immutability and append-only triggers; the counter; the rate function).
- `rls-proof.mjs`, extended to Storage (anon list/read/sign fail on all three buckets).
- A Phase-3 smoke test of the new `sb_secret_` key headers: Roberts sends `Bearer <key>`; a non-JWT secret may need `apikey` only.

Drafts and `published_text` are plaintext server-side, as in Roberts, recorded in `docs/data-handling.md`.

---

## 8. Design application (TEXC tokens)

**Tokens.** Copied verbatim from `texc/app/globals.css` into `assets/css/tokens.css`, kept honest by the content-sync check. No hex in components. Production wins over the artifact and the brief:
- `--steel-400 #8f8f8f`
- large button 44px
- 3px progress bar
- Eyebrows and footer heads in Basement Regular

**Type.**
- Oxanium 800, self-hosted.
- Basement Grotesque only after licence confirmation (Q13). Until then, a documented fallback (`"Arial Narrow", system-ui` for labels, `system-ui` for body), and screenshots are labelled as fallback.

**Surfaces.**
- Ink: cover, top bar, glance, CTA, acceptance, footer.
- Paper `#f4f2ec`: letter through terms. Gold text on paper uses `--doc-gold-text #7a5b17`.
- At most two grounds per surface.
- Photos get an ink scrim and a 2px gold bottom rule. The metallic gradient appears only on the mark and the 2px rules.

**Status colours.** Hazard / caution / go / stop, for hold-point states and later risk ratings only.

**Lean.** The forward lean appears only in the cover title block and the section number tabs.

**Motion.** Reveal, progress bar, header elevation; 120/180/280ms on `cubic-bezier(.16,1,.3,1)`; all removed under `prefers-reduced-motion`.

**Budget.**
- At most 200 KB transferred for HTML, CSS, JS and fonts before images. Dropping SJCL saves 25 KB. Roberts' view is about 78 KB gzipped before fonts.
- Responsive images via `srcset`; pdf.js and the signature pad on demand.
- Target Lighthouse ≥95 for performance and accessibility on mobile.

**Print.**
- A4, `print-color-adjust: exact`, paper grounds, an ink band per section heading.
- `[data-reveal]` forced visible in print CSS; terms expanded.
- `break-inside: avoid` on rows, cards and hold points.
- Running footer: reference · REV · TEXC PTY LTD · ABN.
- Page numbers via `@page` margin boxes where supported (Chromium). Server-side Chromium PDF is proposed for later.

---

## 9. Phases, rough effort, and what each needs from you

These are rough figures for the quoting conversation, at $120/hr ex GST. Each phase ends with:
- the `check.mjs` suites
- 1440 and 390 (2x) screenshots with realistic fictional content
- a scroll video where a whole page changed
- a report

| Phase | Deliverable | Rough hours | Needs |
|---|---|---|---|
| 1 | Static template, CSS, runtime, demo fixture, contract/CSP/print checks, screenshots, video, print PDF | 16–24 | Q2, Q13 |
| 2 | Editor: all panels, rows, library seeded, local autosave, checklist UI | 24–36 | Q14, Q15 |
| 3 | Schema and proofs, accounts, drafts and conflicts, publish RPC, envelope, gate, views and events, notifications, headers, rotation | 28–40 | Q4, Q5, Q8, Q11 |
| 4 | Attachments: buckets, signed upload, verify, gating, viewer | 14–22 (+6–10 if B) | Q6 |
| 5 | Acceptance: RPC, record, staff-recorded, request changes, re-acceptance | 12–18 | Q7 |
| 6 | Archive and dashboard: lifecycle, restore, search, filters, CSV, follow-ups, pipeline and win rate | 18–26 | none |
| 7 | Hardening and handover: a11y and Lighthouse, README, CLAUDE.md, editor guide for George, open items, data handling, `.env.example` | 14–22 | none |
| | **Total** | **≈126–188h (≈$15.1k–$22.6k ex GST)** | |

**Running costs to put in the quote** (confirm current pricing): a paid Supabase plan (free projects pause when idle, which takes live links down), Vercel on a commercial plan, and SMTP2GO on a sending domain.

**Phase 1 demo content.**
- Chalmers structure, fictional client and site (for example "Ashgrove Civil Pty Ltd, North-West Tasmania").
- TEXC's own Chalmers wording, with the client name swapped.
- TEXC-own website photos captioned "TEXC photo — illustrative".
- No Beardwood photos. A DEMO chip.

---

## 10. Open questions (my recommendation in brackets)

1. **Engagement.** Quoted and approved as a Bespoke job with its own BIB number? (Yes, before Phase 1.)
2. **Repo.** May I create private `Creeeds91/texc-proposals` and add it to this session? (Yes, I create it.)
3. **Master index.** None exists by that name. Is it `documents/register.md` plus `documents/distribution/index.html`? (Yes.)
4. **Links.** One link and passphrase per proposal, always the current revision. May clients open superseded revisions with the banner? (Yes, banner always shown.)
5. **Passphrase custody.** Keep it on the server, encrypted, so admins can read it back and revisions reuse it? Or never store it, so staff re-enter it at each publish and a lost one means rotating? (Store it, encrypted, admin-only and audited.)
6. **Malware scanning.** A now, or B now? (A now, B if clients ever upload.)
7. **Acceptance.**
   - May proposals go out with online acceptance before TEXC has T&Cs?
   - Drawn signature, typed, or both?
   - Does TEXC's adviser need set wording?
   - `register.md` already notes a signature block "changes who is on the hook".

   (Yes, wording adapts; both; adviser wording before the first live proposal.)
8. **Reference format.** `TEXC-P-YYYY-NNN` looks like a document code, and `register.md` says codes "cannot be assigned unilaterally". OK as a proposal number outside the taxonomy? (Yes, allocated at first issue so there are no gaps.)
9. **Blast parameters.** Should maximum instantaneous charge or powder factor ever appear on a link-shared page, given "never publish quantities"? (Admin-only, off by default, George decides per proposal.)
10. **Workflow diagram.** Draft, unapproved source; CCR-06 open. Show it to clients? (Off until TEXC approves it.)
11. **Domain and people.** `proposals.texc.au`? Sender `proposals@texc.au` (SPF/DKIM), or the already-trusted `noreply@brandinblack.au` for staff sign-in? Who gets accounts, and in which roles?
12. **From TEXC.** Pricing, terms, validity, T&Cs, insurance wording, George's competencies, and the address and 1800 number (CCR-19). Who chases George?
13. **Fonts.** Does the Basement Grotesque purchase cover a second web property? Until then, system fallback or an OFL stand-in? (System fallback; Oxanium self-hosted.)
14. **Presets.** Ship the one Chalmers-derived hazard and method preset, with the other four job types as CONFIRM slots? (Yes.)
15. **Matrix.** Every row starts as CONFIRM and staff choose TEXC / Client / Shared / To be agreed, rather than pre-filling Chalmers' implied split. (Yes.)

---

## 11. CONFIRM register (seeds `docs/open-items.md`)

| # | Item | Source of the doubt |
|---|---|---|
| C1 | Rate presets: $150/hr, 4h minimum per mobilisation, standby 50%, travel agreed or 50%, weekly/per-mobilisation invoicing on 14 days, mobilisation at cost + GST, labour-only | `documents/phase-2-proof/_ds/…/_ds_bundle.js` "Rates" component, a superseded prototype |
| C2 | Payment terms, default validity, link-expiry period | None supplied |
| C3 | T&Cs text and version | None exist |
| C4 | Insurance wording. The prototype's "Full insurance & compliance coverage" is not usable. | `pages.ts` `safety.assurance` is deliberately neutral |
| C5 | George's 11 units and 3 licences; suffix inconsistencies (RIIBLA401/402, RIIPLA403) | `pages.ts` team, CONFIRM |
| C6 | Street address, 19 Wynwood Road, Sprent TAS 7315 | `documents/` only; CCR-20 |
| C7 | Emergency response, 1800 833 111 | CCR-19 |
| C8 | National vs Tasmania-only wording | `site.ts` vs `pages.ts`/`home.ts` |
| C9 | Reference format | `register.md` |
| C10 | Client-facing status wording; TEXC's own is "Preliminary - For Review" | `reference/project-documents.md`: never paraphrased |
| C11 | Misfire line adapted from "an enquiry form is not an emergency channel" | `services.ts` compliance line |
| C12 | Covering-letter template | New text |
| C13 | Hazard presets: civil, quarry & mining, microblasting, shot sleeping, misfire | None exist |
| C14 | Risk rating scale | CCR-03 |
| C15 | Hazard "owner" column | Not in any TEXC source |
| C16 | Responsibility-matrix assignments | Operational content |
| C17 | Methodology presets beyond Chalmers | None exist |
| C18 | Powder-factor unit; whether MIC and powder factor may be published | CCR-13; `services.ts` |
| C19 | Flyrock, dust, noise and monitoring wording | Operational content |
| C20 | Generic logistics commitments | From `services.ts`; needs sign-off as proposal lines |
| C21 | Workflow diagram; Transfer Note vs Load Manifest; stage-to-document mapping (Magazine Record Sheet → TEXC06?, Manifest → TEXC04, Blast Report → TEXC07) | "Draft — not approved"; CCR-06 |
| C22 | TEXC12 as a deliverable | Draft awaiting approval |
| C23 | Remote Area Operations, Marine & Coastal | `pending: true`; excluded |
| C24 | Document-type labels | Brief only |
| C25 | Acceptance legal wording and signature type | Q7 |
| C26 | Basement Grotesque licence for this property | `docs/spec.md` hard blocker |
| C27 | Domain, sender, SPF/DKIM | Q11 |
| C28 | Staff list and roles | Q11 |
| C29 | Default cover photo. TEXC-own only; `civil-blast-pattern` shows houses in the full frame. | `public/assets/README.md` |
| C30 | Reusing website copy (About, capability strip, values) in proposals | Approved for the website only |
| C31 | Proposals privacy notice: names, emails, signatures, hashed IPs | Draft privacy page, needs legal review |
| C32 | "Labour-only (no equipment supplied)" vs MPU "equipment provision is confirmed on enquiry" | Prototype vs `services.ts` |
| C33 | Chalmers-derived presets approved for other clients | Beardwood-specific source |
| C34 | Whether texc.au is still aliased to deployment `33e8068` (one browser check) | §12 |
| C35 | 000 emergency line reused on proposals | `pages.ts contact.emergency`, website wording |
| C36 | Logistics section has no free text, deliberately | Brief implied editable content |

---

## 12. Live site vs repo

**Direct fetch failed.** This environment's network policy blocks texc.au. To allow it, add `texc.au` under Allowed domains in the cloud environment's network settings.

**Indirect proof.** Vercel's read-only API shows the production deployment of project `texc` (READY, about 8 Sep 2026) was built from `33e8068`, which is exactly this checkout, with a clean tree. Static export, no CMS. To high confidence, **repo copy = production copy** (C34 covers the one gap).

**Inconsistencies in that copy:**
- Service area (C8).
- Competency code suffixes (C5).
- **Website bug** (separate task queued, not this job): the "All services →" mega-menu link never renders, because `Header.tsx:60` checks a column heading that `site.ts` renamed.

---

## 13. Verification

**Every phase.** `node scripts/build.mjs` is deterministic (a clean tree after build means committed artifacts are current). `node scripts/check.mjs` runs these suites:
- `contract` (with `--prove`)
- `brand`
- `csp`: no inline script, no `style=` in views, headers present
- `conventions`: no `console.*`, no `select=*`, no echoed DB errors
- `confirm`: a fixture full of `$confirm` publishes zero CONFIRM text, and the server refuses publish
- `quote`: a property test over cents, half-up per line, GST once, options on and off, run identically against the browser and server `money.js`
- `content-sync`

**Phase 1.** `scripts/demo/capture.mjs` (Playwright, Chromium at `/opt/pw-browsers`):
- 1440 and 390 stills of every section, and a scroll video
- `page.pdf()` in A4
- `print` suite: every visible `data-sec` has ink on the printed page
- Every capture is looked at before sending.

**Phase 3.**
- `schema-standup-check` twice on a scratch database, then `rls-proof` including Storage.
- `refusals` suite: wrong token, wrong vt, expired, archived, withdrawn and never-existed give byte-identical 410s on every client endpoint.
- Envelope round-trip: encrypted in Node, decrypted by WebCrypto in Chromium, plaintext hashes equal.

**Phase 4.** `attachments` suite. Fixtures:
- passes: a clean PDF; a bare `/OpenAction`
- rejected: `/JavaScript`; a hex-escaped `/J#61vaScript`; encrypted; a spoofed `%PDF`; over the cap
- a deflate bomb (refused within budget)
- a TEXC exemplar (rejected), then its flattened copy (passes)
- the 60s URL, and the 410 paths

**Phase 5.** 20 parallel accepts **against the scratch database**: exactly one winner, and the rest get `already:true`. Also: a tampered total (the server recomputes), a wrong fingerprint (410), and accepting a superseded revision (410).

**End to end** (definition of done), driven by Playwright on `local-app`:
- Create from preset in under 10 minutes.
- Attach and publish.
- Unlock at iPhone 390 and time it (target under 1s).
- Open an attachment, tick an option, accept with a signature.
- The email stub receives the acceptance.
- The dashboard timeline shows every event.
- Rev A shows the superseded banner.
- Print has no blank section.
- Every client refusal is 410.

**After approval.** On approval, the first actions are:
1. Create the repo (Q2).
2. Write `CLAUDE.md`, `docs/open-items.md` (§11) and `docs/architecture.md` (this plan) as the first commit.
3. Start Phase 1.

Work goes on a feature branch and nothing reaches `main` without your say.

---

## 14. Phase 3 as built (13 Oct 2026)

Where the build refines the plan above. Each is a deliberate change, recorded
so the plan and the code do not disagree silently.

**Two-layer encryption, so rotation never touches what was published.** §1
said each revision is encrypted under the passphrase. As built, each revision's
bytes are encrypted ONCE under a random 256-bit content key
(`texc_proposal_revisions.enc`, immutable), and only that key is wrapped by the
passphrase-derived key (PBKDF2-SHA256, 600,000 rounds, fresh salt) in
`texc_revision_keys`. "Rotate link and passphrase" re-wraps those keys in one
transaction (`texc_rotate`); the ciphertext and its `enc_sha256` never change,
which keeps the immutability triggers absolute. `lib/envelope.js` (server) and
`assets/js/envelope-client.js` (browser) are the two halves;
`check.mjs envelope` proves they agree.

**References are claimed before the bytes are built.** The reference is printed
inside the encrypted proposal, so it must exist before encryption:
`texc_claim_reference` allocates it on the first publish attempt and the
proposal keeps it forever (no gaps between proposals). The revision letter is
checked under the row lock by `texc_publish`; if someone published in between,
it refuses with 409 and the server rebuilds once with the next letter.

**Errors carry HTTP status codes from the database.** Conflicts raise
PostgREST's `PT409` / `PT404`, not `40001` (which PostgREST retries).

**Website wording is frozen into each revision.** The published config carries
`tpl`: the locked lines, website snapshot text, and only the services, people,
register entries and photographs it uses. The runtime prefers it over the
page's own copy, so a website edit never changes an issued proposal.

**Photographs go through our own function.** Uploads POST to
`/api/staff-media` (magic bytes and size checked, content-addressed paths,
never overwritten) rather than to a signed upload URL, so the editor's
`connect-src` stays `'self'`. Clients get one-hour signed links for exactly
the photographs their revision names. `img-src` allows `https://*.supabase.co`
until the project exists; narrow it to the one origin then (`lib/csp.js`).

**Static files are an explicit list.** Vercel serves only `public/`
(`outputDirectory`), which `node scripts/build.mjs --public` fills with the
assets, the client page and `robots.txt` — never `lib/`, `content/` or
`templates/`. The demo page and fixture are added only with `DEMO_PUBLIC=1`.
Proved on the first preview deployment (open item D1).

**The editor has no separate dashboard yet.** `/editor` opens the list of
proposals; People (approving access) is in the editor's menu for
administrators. The archive and reporting dashboard remain Phase 6.

**The server and the editor share one checklist.** Publishing re-runs
`assets/js/checks.js` on the stored draft at the exact version the editor saw,
then the allowlist projection, then a final scan of the bytes for `CONFIRM`.

**Run it.** `node scripts/demo/local-app.mjs` starts real Postgres 16 and the
real PostgREST (Docker) behind the real `api/*` handlers, with a file-backed
stand-in for Storage and a local outbox for email. Nothing touches a hosted
service. `node scripts/schema-standup-check.mjs` proves the schema on a fresh
database.

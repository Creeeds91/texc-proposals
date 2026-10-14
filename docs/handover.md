# Handover and go-live

What is built, what must happen before the first live proposal, how to put it
online, and how to look after it. For Brand in Black and TEXC. The plan is
`docs/architecture.md`; open questions live in `docs/open-items.md`.

---

## 1. What is built (14 Oct 2026)

| Phase | What | Where it is described |
|---|---|---|
| 1 | The client page: TEXC's design, every section, print to A4 | architecture §3, §8 |
| 2 | The editor: panels, library, checklist, photographs | §4 |
| 3 | Database, staff accounts, publishing, the passphrase gate, revisions, link rotation | §14 |
| 4 | PDF documents: upload, structural check, release, viewer, download | §15 |
| 5 | Online acceptance: signature, stored record, re-acceptance, requests for changes | §16 |
| 6 | Dashboard and archive: figures, chart, follow-ups, search, history, CSV | §17 |
| 7 | Hardening and handover: deleting for good, two security reviews, accessibility, speed, this document, the staff guide | §18 |
| 8 | Documents: a library of standing documents (certificates, licences, procedures) offered on any proposal, with expiry watched; several PDFs at once | §19 |
| 9 | The archive: every revision ever sent, found by client, site, service, reference or document code and opened as it was sent; a record pack per proposal with every fingerprint checked; keeping periods and a daily retention run | §20 |

Nothing is deployed. Everything runs locally against a throwaway database
(`node scripts/demo/local-app.mjs`), and every check passes there.

## 2. Before the first live proposal

These are decisions or content from TEXC, not code. The system works without
them, but a proposal should not go to a client until each is settled.

| # | What | Why it matters |
|---|---|---|
| C25 | Acceptance wording reviewed by TEXC's adviser | A client accepting online is agreeing to something; the words must be TEXC's |
| C38 | TEXC approves the wording Brand in Black drafted (acceptance page, request for changes, emails, record headings) | Same |
| C31 | A privacy notice for proposals | Acceptance stores a person's name, email, signature and a keyed hash of their connection |
| Q7, C3 | Terms and conditions, with a version | Until then the acceptance sentence leaves terms out |
| C1, C2 | Rates, payment terms, default validity, link expiry | The rate presets are from an old prototype and are marked CONFIRM |
| C27 | The domain (`proposals.texc.au`?) and a sender address with SPF and DKIM | Emails from an unauthenticated sender land in junk |
| C28 | Who gets an account, and in which role | George as administrator; the rest as editors or viewers |
| C26 | Whether TEXC's Basement Grotesque licence covers this site | Until then labels and body text use a system fallback |
| C39 | Follow-up timings, archive reasons, default period | Defaults chosen by Brand in Black |
| C40 | The standing documents for the library, and who checks a certificate before it is approved | The library starts empty |
| C43 | How long proposal records are kept: when an expired, unaccepted proposal is archived, and how many years an accepted one is kept | Until set, nothing is archived automatically and no accepted proposal can be deleted |

The full list, with sources, is `docs/open-items.md`.

## 3. Putting it online

Paid services need Jesse's approval before they are created (D2). Approved
14 Oct 2026; where each step stands is in the table below, and the numbered
steps after it are the full procedure.

### Where it stands (14 Oct 2026)

| Step | Who | State |
|---|---|---|
| Vercel project `texc-proposals` (team BRAND IN BLACK, functions in `syd1`, toolbar off, Vercel sign-in on everything but a custom domain) | Claude | Done. Linked to `Creeeds91/texc-proposals`; production branch `main` |
| Plain variables: `ACCOUNT_DOMAINS`, `MAIL_FROM` (Production and Preview), `PUBLIC_BASE_URL` (Production), `DEMO_PUBLIC=1` (Preview) | Claude | Done |
| First deployment, built from the feature branch | Claude | Ready at `texc-proposals.vercel.app` behind Vercel sign-in. Vercel made it the project's **production** deployment (its first), though it was asked for a preview; it has no database secrets, so it opens nothing. A merge to `main` replaces it |
| On that deployment, from outside: `robots.txt` refuses everything, a private source file answers the styled 404, sign-in is served from `syd1` under exactly one policy, and the pdf.js worker is this checkout's byte for byte under its own narrower policy | Claude | Done (the header half of D5) |
| Supabase project `texc-proposals`, Sydney (`ap-southeast-2`), Postgres 17, in the Brand in Black organisation | Jesse, in the dashboard | **To do.** The connector's create call timed out twice without creating it. Keep the database password in the password manager |
| Load `supabase/schema.sql` into it, then check it from outside (security advisors; the publishable key refused on every table and function; the three buckets private) | Claude | Waiting on the project. The schema is proven on Postgres 17.11 (82 promises) |
| Secret variables in Vercel: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Supabase → Settings → API Keys → new secret key), `VAULT_KEY` (`openssl rand -base64 32`, **a copy kept offline**), `IP_HASH_KEY` and `CRON_SECRET` (`openssl rand -hex 24` each), `SMTP2GO_API_KEY`, `ACCOUNT_SUPERS`, `NOTIFY_TO` | Jesse | To do. Typed into Vercel, never into a chat or a file |
| `texc.au` as a sender in SMTP2GO, and its SPF and DKIM records at **GoDaddy** (texc.au's DNS is at GoDaddy, not Vercel) | Jesse, with TEXC's GoDaddy login | To do. Until then sign-in codes cannot be sent from `proposals@texc.au` |
| D3: narrow `https://*.supabase.co` to the project's own address in `lib/csp.js` and `vercel.json` | Claude | Once the project exists |
| The deploy check (`scripts/deploy-check.mjs`) in full, signed in | Claude | Needs `*.vercel.app` allowed in this environment's network settings (it is refused), the bypass secret, and a staff session |
| `proposals.texc.au`: added to the Vercel project, and a CNAME at GoDaddy to the target Vercel shows | Claude adds it; the record at GoDaddy by whoever holds the login | **Last**: only once `main` carries the release. A custom domain bypasses Vercel sign-in |
| Merge to `main` (the production branch) | Jesse approves the pull request | After the checks above |

1. **Supabase**, Sydney region, on a paid plan (a free project pauses when
   idle, which takes every client link down).
   - SQL editor: run `supabase/schema.sql` once. It creates every table,
     function and trigger, locks them all from the public key, and declares
     the three private buckets with their size and type limits.
   - Settings → API: copy the project URL and the **secret** key.
2. **SMTP2GO**: add the sending domain and publish its SPF and DKIM records.
3. **Vercel**: a project on this repository, framework "Other". Set the
   variables in `.env.example`, for Production and Preview:
   - `VAULT_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). **Keep
     a copy offline.** Without it no passphrase can be read back and no
     existing proposal can be published again.
   - `IP_HASH_KEY`: any long random string.
   - `ACCOUNT_SUPERS`: Brand in Black's addresses. `ACCOUNT_DOMAINS`: `texc.au`.
   - `PUBLIC_BASE_URL`, `MAIL_FROM`, `SMTP2GO_API_KEY`, `NOTIFY_TO` (and
     `NOTIFY_BCC` if a records mailbox should get every acceptance).
   - `CRON_SECRET` (Production): at least 16 random characters
     (`openssl rand -hex 24`). Vercel sends it to the daily retention run;
     without it the run never happens (D7).
4. **A preview deployment first** (`DEMO_PUBLIC=1` on Preview only). Turn
   the Vercel Toolbar off for Preview (project Settings → General): it
   injects a script the strict policy blocks, and its errors would cloud
   D5's console check. On the preview, prove what could only be stood in for
   locally:
   - Run `node scripts/deploy-check.mjs --url <the preview's address>`. Set
     `VERCEL_PROTECTION_BYPASS` if the preview is protected, and
     `STAFF_SESSION` to a signed-in session (the `__Host-texc_sess` cookie,
     from the browser's developer tools) to include the editor and
     dashboard. With GET requests only, it checks D1 (no private file is
     served), that every page and file is this checkout's build, each page's
     security policy (exactly one) and shared headers, pdf.js's own policy
     and file types, the 404, the sign-in redirect and the functions'
     region. It must report nothing WRONG.
   - D4, by hand: attach a document, preview it, download it (signed
     upload, CORS, download name).
   - D5, by hand: open a document in the client viewer with the console
     open: no Content Security Policy errors.
   - D3: then narrow `https://*.supabase.co` to the project's own address in
     `lib/csp.js` and `vercel.json` (the `csp` check holds the two equal),
     redeploy, and run the deploy check again: it names the one origin.
5. **The domain**: point `proposals.texc.au` (or the chosen name) at Vercel.
   Then `node scripts/deploy-check.mjs --url https://proposals.texc.au
   --production`: the demo must be gone and D3 narrowed.
6. **First accounts**: a Brand in Black address in `ACCOUNT_SUPERS` signs in,
   George asks for access from the sign-in page, and the super approves him
   as administrator under People. George then approves his own staff.
7. **A first real proposal end to end**, to a TEXC address acting as the
   client: publish, open, open a document, accept, and check the emails and
   the record. Then take its record pack from the Archive: it must say every
   fingerprint matches.
8. **The daily run** (D7): in Vercel, Settings → Cron Jobs lists
   `/api/retention` once a day. With no keeping period set it archives
   nothing; the staff audit shows a run only when it archived something.

## 4. Looking after it

- **Backups.** Supabase's paid plan keeps daily backups. If a table ever has
  to be restored from a file, restore by column **name**, never by position
  (`CLAUDE.md`: columns added later are appended, so the order differs from
  a tidy table and a positional restore would put values in the wrong
  columns).
- **Checks before any change**: `node scripts/build.mjs`, then
  `node scripts/check.mjs` (every suite; exit 3 means something was not
  checked, never "fine"), then `node scripts/demo/capture.mjs` and look at
  the pictures. `node scripts/schema-standup-check.mjs` before any database
  change.
- **The accessibility and Lighthouse checks** need two tools that are not
  part of this repository:
  `npm install --prefix ~/.cache/texc-audit-tools axe-core@4.13.0 lighthouse@13.4.1`.
- **The staff audit** (`texc_staff_audit`) records every sensitive staff
  action: passphrase read-backs, link rotations, releases of documents,
  recorded acceptances, archives, exports, deletions. Read it in Supabase's
  table editor or SQL editor; it cannot be changed or deleted.
- **Deleting for good** (Brand in Black, from the dashboard): only 90 days
  after archiving, by typing its reference; an accepted proposal only after
  its keeping period, and never while none is set.
- **Records for an inquiry or a dispute**: the Archive's record pack for that
  proposal (editors and administrators). Keep the zip as it is; anyone can
  re-check it with `sha256sum -c SHA256SUMS`.
- **Rotating the Supabase secret key**: create the new key, update
  `SUPABASE_SECRET_KEY` in Vercel, redeploy, then revoke the old key.
- **The care plan** is mandatory for the first 12 months (Brand in Black's
  terms): updates to pdf.js and Supabase, checks re-run, and help when
  something goes wrong.

## 5. Accepted limits

Things deliberately not built, or risks judged acceptable, so nobody
discovers them by surprise.

- **Photographs and documents are not encrypted with the passphrase.** They
  sit in private buckets and are reached only through signed links that last
  an hour (photographs) or 60 seconds (documents), issued to someone who has
  already opened the proposal.
- **The PDF check is structural, not a virus scan** (Q6 option A). It fails
  closed: anything it cannot read for certain is "cannot verify" and needs an
  administrator's release. Clients never upload. Option B (ClamAV in Sydney)
  is the step if that ever changes.
- **Storage per proposal is capped** (40 stored files, including uploads
  begun and never checked), but staff are trusted not to make many large
  proposals to fill storage; uploads are rate-limited and recorded.
- **Lighthouse is measured on the demo page.** The real client page is the
  same page behind the passphrase; its first screen (the gate) is lighter.
- **One theoretical gap in the PDF check, judged not reachable.** When a
  stream's length is given indirectly, the check reads to the first
  "endstream" after it. A compressed stream whose bytes happened to contain
  that word would be read short; the second review could not produce one that
  hides a script, because compressed output cannot be steered to contain a
  chosen word and uncompressed text is scanned whole anyway. Treating every
  indirect length as unreadable would refuse most real PDFs.
- **The drawn signature cannot be made from a keyboard.** Proposals default
  to "drawn or typed".

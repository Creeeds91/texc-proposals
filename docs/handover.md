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

The full list, with sources, is `docs/open-items.md`.

## 3. Putting it online

Paid services need Jesse's approval before they are created (D2).

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
   the record.

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
  after archiving, never an accepted proposal, by typing its reference.
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

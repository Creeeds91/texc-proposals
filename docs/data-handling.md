# Data handling

What this system holds, where, and who can read it. Kept short and current;
change it in the same commit as anything it describes.

| What | Where | Readable by |
|---|---|---|
| Draft proposals (everything staff type, including the client's email) | `texc_drafts.config`, plaintext | The server (secret key); staff with an editor session |
| Each published revision, exactly as the client receives it | `texc_proposal_revisions.published_text`, plaintext; `.enc`, encrypted | Plaintext: the server and staff tools. Encrypted copy: anyone holding the link, but only opened with the passphrase |
| Passphrases | `texc_proposals.passphrase_enc`, sealed with `VAULT_KEY` (never in the database) | The server; an administrator by audited read-back |
| Link tokens | `texc_proposals.access_token`, plaintext | The server; staff (to copy the link) |
| Uploaded photographs | Storage bucket `texc-media`, private | One-hour signed links: staff in the editor, and a client for the photographs their revision names |
| Attached documents (PDFs) | Storage bucket `texc-attachments`, private; the facts and the check's findings in `texc_attachments` (name, SHA-256, size, pages, verdict, who uploaded, who released it and why) | 60-second signed links: staff (editor and above) for any file on a proposal; a client only for a file their decrypted revision offers as "the client can open it". A refused file that can never be served is deleted at once |
| Acceptances | `texc_acceptances`, append-only: name, position, company and email as typed, both confirmations, the optional items and total accepted, the typed signature, the text and revision fingerprints, a keyed hash of the connection, the device family, the session; for staff-recorded ones, who recorded it and their note | The server; staff (the editor's status and the record page) |
| Drawn signatures and acceptance records | Storage bucket `texc-acceptances`, private: the signature PNG and the self-contained record page (which embeds the signature), fingerprinted in the row | Staff only, through `/staff/acceptance/<id>` after the fingerprint is checked. Never a client |
| Requests for changes | `texc_events` (`changes_requested`): name, email and message as typed | The server; staff; the office by email |
| Staff accounts | `texc_users` (email, name, role, status) | The server; administrators in People |
| Sign-in codes and sessions | `texc_login_tokens`, `texc_user_sessions`: SHA-256 hashes only | Nobody can recover a code or a session from them |
| What clients did (opened, ticked an option, printed, opened or downloaded a document) | `texc_events`, `texc_proposal_views`: device family, region, a keyed hash of the IP — never the address | The server; staff on the dashboard (any role) |
| Archive state and practice flag | `texc_proposals.archived_at`, `archived_by`, `archive_reason`, `is_test`; each change also in `texc_events` and the staff audit | The server; staff on the dashboard |
| Search words | `texc_proposals.search_extra` (document type, service names, the contact's name, document titles) and the generated `search` column | The server only; staff see the results |
| The dashboard's data | Read live through `texc_overview()`: per proposal, its listing, dates, value, counts of opens, sessions, documents opened and items ticked, acceptance facts and the contact's name. No link token, passphrase or proposal content | Staff, any role; the client link only to editors and above |
| CSV exports | Not stored: built on request from the same data and downloaded. Each export is written to `texc_staff_audit` (who, filters, row count) before the file is sent | Editors and above. A downloaded copy is outside this system's control |
| Who on the staff side did something sensitive | `texc_staff_audit`, append-only | The server; Brand in Black |

The database has row-level security on every table and no policies, so the
public (anon) key reads nothing. Everything goes through the server with the
secret key. A copy of the database alone reveals drafts and published text,
but no passphrase, no sign-in code and no session.

Region: Supabase in Sydney (`ap-southeast-2`); Vercel functions pinned to
`syd1`. Email goes through SMTP2GO.

A document's bytes are not encrypted with the proposal's passphrase: they sit
in the private bucket like the photographs, and only a short-lived signed link
reaches them. Whoever holds such a link in its 60 seconds can fetch the file.

Still to settle: the privacy notice for proposals (C31) — needed before the
first live acceptance — and how long drafts, views, events, attached files,
acceptances and their records are kept. An acceptance is a business record;
expect it to be kept at least as long as TEXC keeps contracts.

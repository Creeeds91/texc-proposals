/**
 * POST /api/attachment { slug, t, vt, rev, id, download, session }  → { url, name, bytes }
 *
 * A 60-second link to one document a revision offered its client. The file
 * comes from the published revision's own snapshot — never from the request —
 * so a caller can only ever reach what that revision listed as "the client can
 * open it", and only after decrypting it (the view token). The link is long
 * enough to start a download and no longer: one request, read to the end.
 *
 * Opening and downloading are recorded. Every refusal is the uniform 410.
 */
import { db, one } from '../lib/db.js';
import { body, gone, onlyMethods, noStore } from '../lib/http.js';
import { resolve, viewTokenOk } from '../lib/client-access.js';
import { signUrl, ATTACH_BUCKET } from '../lib/storage.js';
import { recordEvent } from '../lib/events.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 10 };
const CARD_RE = /^[a-z0-9-]{1,40}$/i;

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST'])) return;
  const d = db();
  if (!d) { gone(res); return; }
  if (await rateLimited(d, req, 'attachment', 30, 60)) { tooMany(res); return; }
  const b = body(req, 2000);
  const card = String(b.id || '');
  if (!CARD_RE.test(card)) { gone(res); return; }
  const found = await resolve(d, { slug: b.slug, t: b.t, rev: b.rev || '' });
  if (!found || !viewTokenOk(found.rev, b.vt)) { gone(res); return; }
  const row = await one(d, `texc_proposal_revisions?id=eq.${found.rev.id}&select=attachments_snapshot`);
  const entry = row && Array.isArray(row.attachments_snapshot) ? row.attachments_snapshot.find((x) => x && x.card === card) : null;
  if (!entry || typeof entry.path !== 'string') { gone(res); return; }
  const download = b.download === true;
  const url = await signUrl(ATTACH_BUCKET, entry.path, 60, { downloadName: download ? entry.name : '' });
  if (!url) { res.status(503).json({ error: 'unavailable' }); return; }
  await recordEvent(d, {
    proposalId: found.prop.id, revisionId: found.rev.id, event: download ? 'attachment_downloaded' : 'attachment_opened',
    session: String(b.session || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64), meta: { card, title: String(entry.title || '').slice(0, 120) },
  });
  res.status(200).json({ url, name: entry.name, bytes: entry.bytes });
}

/**
 * GET /api/proposal?slug=<slug>&t=<token>[&rev=<A>]
 *
 * The encrypted revision for a client link: { enc, key, rev, current, revisions }.
 * Public on purpose — it is ciphertext, useless without the passphrase — but
 * only for the right slug AND token, a live link and a revision that was not
 * withdrawn. Every refusal is the identical 410 (lib/http.js GONE).
 */
import { db, one } from '../lib/db.js';
import { gone, noStore, onlyMethods } from '../lib/http.js';
import { resolve } from '../lib/client-access.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 10 };
const LOOKUPS_PER_MIN = 30;

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['GET'])) return;
  const d = db();
  if (!d) { gone(res); return; }
  if (await rateLimited(d, req, 'proposal', LOOKUPS_PER_MIN, 60)) { tooMany(res); return; }
  const q = req.query || {};
  const found = await resolve(d, { slug: q.slug, t: q.t, rev: q.rev || '' });
  if (!found) { gone(res); return; }
  const key = await one(d, `texc_revision_keys?revision_id=eq.${found.rev.id}&select=kdf,iter,salt,iv,wrapped`);
  const row = await one(d, `texc_proposal_revisions?id=eq.${found.rev.id}&select=enc`);
  if (!key || !row) { gone(res); return; }
  res.status(200).json({ enc: row.enc, key, rev: found.rev.rev_label, current: found.current.rev_label, revisions: found.revisions });
}

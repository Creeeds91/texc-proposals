/**
 * POST /api/media { slug, t, vt, rev }  → { media: { id: { srcset: [[w, url]] } } }
 *
 * One-hour links to the photographs a revision uses, for a client who has
 * decrypted it (view token). The list comes from the published revision
 * itself, never from the request, so a caller cannot ask for anything else.
 * Refusals are the uniform 410.
 */
import { db, one } from '../lib/db.js';
import { body, gone, onlyMethods, noStore } from '../lib/http.js';
import { resolve, viewTokenOk } from '../lib/client-access.js';
import { signUrls, MEDIA_BUCKET } from '../lib/storage.js';
import { mediaPath } from '../lib/proposals.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST'])) return;
  const d = db();
  if (!d) { gone(res); return; }
  if (await rateLimited(d, req, 'media', 30, 60)) { tooMany(res); return; }
  const b = body(req, 2000);
  const found = await resolve(d, { slug: b.slug, t: b.t, rev: b.rev || '' });
  if (!found || !viewTokenOk(found.rev, b.vt)) { gone(res); return; }
  const row = await one(d, `texc_proposal_revisions?id=eq.${found.rev.id}&select=published_text`);
  let published = {};
  try { published = JSON.parse(row.published_text); } catch { gone(res); return; }
  const wanted = [];
  for (const [id, m] of Object.entries(published.media || {})) {
    for (const w of (m && m.widths) || []) wanted.push([id, w, mediaPath(found.prop.id, id, w, m.type)]);
  }
  const urls = await signUrls(MEDIA_BUCKET, wanted.map((x) => x[2]), 3600);
  const media = {};
  for (const [id, w, path] of wanted) if (urls[path]) (media[id] ||= { srcset: [] }).srcset.push([w, urls[path]]);
  res.status(200).json({ media });
}

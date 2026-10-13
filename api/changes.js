/**
 * POST /api/changes { slug, t, vt, rev, session, name, email, message }  → { sent: true }
 *
 * The client asks for changes instead of accepting. Logged against the
 * revision they were reading and emailed to the office; nothing is claimed and
 * the proposal stays open. 422 for a form problem; the uniform 410 otherwise.
 */
import { db } from '../lib/db.js';
import { body, gone, onlyMethods, noStore } from '../lib/http.js';
import { resolve, viewTokenOk } from '../lib/client-access.js';
import { requestChanges } from '../lib/acceptances.js';
import { rateLimited, limitStrict, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST'])) return;
  const d = db();
  if (!d) { gone(res); return; }
  if (await rateLimited(d, req, 'changes', 5, 3600)) { tooMany(res); return; }
  const b = body(req, 20_000);
  const found = await resolve(d, { slug: b.slug, t: b.t, rev: b.rev || '' });
  if (!found || !viewTokenOk(found.rev, b.vt)) { gone(res); return; }
  // However many connections a requester uses, one proposal sends the office at most 20 a day.
  if (await limitStrict(d, `changes-proposal:${found.prop.id}`, 20, 86400)) { tooMany(res); return; }
  const out = await requestChanges(d, req, found, b);
  res.status(out.status).json(out.json);
}

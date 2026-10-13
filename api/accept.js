/**
 * Acceptance, client side (lib/acceptances.js holds the rules).
 *
 *   POST /api/accept { slug, t, vt, rev, action: 'status' }
 *        → { accepted, open, earlier }   is this revision accepted, can it be, was an earlier one
 *   POST /api/accept { slug, t, vt, rev, session, action: 'accept', name, position, company, email,
 *                      authority, accept, typed, drawn, options, totalCents, plaintextSha256 }
 *        → { accepted: true, acceptance } | { already: true, acceptance }
 *          422 { error: 'incomplete', fields }   a form problem the page should have caught
 *          409 { error: 'total', totalText }      the total shown is not the revision's total
 *
 * Every refusal of access — a bad link, a wrong view token, an earlier or
 * withdrawn revision, bytes other than the published ones — is the uniform 410.
 */
import { db } from '../lib/db.js';
import { body, gone, onlyMethods, noStore } from '../lib/http.js';
import { resolve, viewTokenOk } from '../lib/client-access.js';
import { statusFor, clientAccept } from '../lib/acceptances.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST'])) return;
  const d = db();
  if (!d) { gone(res); return; }
  const b = body(req, 400_000);
  const accepting = b.action === 'accept';
  if (!accepting && b.action !== 'status') { gone(res); return; }
  if (await rateLimited(d, req, accepting ? 'accept' : 'accept-status', accepting ? 10 : 60, accepting ? 600 : 60)) { tooMany(res); return; }
  const found = await resolve(d, { slug: b.slug, t: b.t, rev: b.rev || '' });
  if (!found || !viewTokenOk(found.rev, b.vt)) { gone(res); return; }
  if (!accepting) { res.status(200).json(await statusFor(d, found)); return; }
  const out = await clientAccept(d, req, found, b);
  if (out.status === 410) { gone(res); return; }
  res.status(out.status).json(out.json);
}

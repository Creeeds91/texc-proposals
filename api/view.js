/**
 * POST /api/view { slug, t, vt, rev, session }  → 204, always.
 *
 * A client opened (decrypted) a revision. Only a caller holding the revision's
 * view token — which exists only inside the encrypted proposal — is recorded,
 * so a link alone cannot fake an open. The first ever open tells the office.
 * Record-only: the answer is 204 whatever happened, so it reveals nothing.
 */
import { db, rpc } from '../lib/db.js';
import { body, onlyMethods, noStore, deviceFamily } from '../lib/http.js';
import { resolve, viewTokenOk } from '../lib/client-access.js';
import { rateLimited, callerHash } from '../lib/ratelimit.js';
import { sendEmail, layout } from '../lib/notify-email.js';
import { BRAND } from '../lib/brand.js';
import { baseUrl } from '../lib/proposals.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST'])) return;
  const done = () => { res.statusCode = 204; res.end(); };
  const d = db();
  if (!d) return done();
  if (await rateLimited(d, req, 'view', 30, 60)) return done();
  const b = body(req, 2000);
  const found = await resolve(d, { slug: b.slug, t: b.t, rev: b.rev || '' });
  if (!found || !viewTokenOk(found.rev, b.vt)) return done();
  const h = req.headers || {};
  const r = await rpc(d, 'texc_record_view', { p: {
    proposal_id: found.prop.id, revision_id: found.rev.id, session: String(b.session || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64) || null,
    device: deviceFamily(h['user-agent']), region: String(h['x-vercel-ip-country-region'] || '').slice(0, 20), ip_hash: callerHash(req),
  } });
  if (r.ok && r.json && r.json.first === true && process.env.NOTIFY_TO) {
    const p = found.prop;
    const mail = layout({
      heading: 'A proposal was opened for the first time',
      paras: [`${p.client_company || 'The client'} opened ${p.reference || 'their proposal'}${p.project ? ` (${p.project})` : ''}, revision ${found.rev.rev_label}.`],
      button: { label: 'Open the editor', href: `${baseUrl()}/editor/${p.id}` },
    });
    await sendEmail({ to: process.env.NOTIFY_TO.split(/[;,\s]+/).filter(Boolean), subject: `Opened: ${p.reference || BRAND.name + ' proposal'}`, ...mail });
  }
  return done();
}

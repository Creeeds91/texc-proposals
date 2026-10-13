/**
 * POST /api/event { slug, t, vt, rev, event, session, meta }  → 204, always.
 *
 * Something a client did on the page — ticked an optional item, printed it.
 * Only names in CLIENT_EVENTS are kept, only from a caller holding the view
 * token, and meta is reduced to a few short fields.
 */
import { db } from '../lib/db.js';
import { body, onlyMethods, noStore } from '../lib/http.js';
import { resolve, viewTokenOk } from '../lib/client-access.js';
import { recordEvent, CLIENT_EVENTS } from '../lib/events.js';
import { rateLimited } from '../lib/ratelimit.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST'])) return;
  const done = () => { res.statusCode = 204; res.end(); };
  const d = db();
  if (!d) return done();
  if (await rateLimited(d, req, 'event', 60, 60)) return done();
  const b = body(req, 2000);
  if (!CLIENT_EVENTS.includes(b.event)) return done();
  const found = await resolve(d, { slug: b.slug, t: b.t, rev: b.rev || '' });
  if (!found || !viewTokenOk(found.rev, b.vt)) return done();
  const m = b.meta && typeof b.meta === 'object' ? b.meta : {};
  const meta = {};
  if (typeof m.option === 'string') meta.option = m.option.slice(0, 40);
  if (typeof m.on === 'boolean') meta.on = m.on;
  await recordEvent(d, { proposalId: found.prop.id, revisionId: found.rev.id, event: b.event, session: String(b.session || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64), meta });
  return done();
}

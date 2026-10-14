/**
 * The dashboard's data. Staff, any role.
 *
 *   GET /api/analytics             → { now, role, rows, services, docTypes }
 *                                    one row per proposal (texc_overview), archived included;
 *                                    the page works out states and figures with assets/js/lifecycle.js
 *   GET /api/analytics?q=<words>   → { ids }  proposals whose words start with these (texc_search)
 *   GET /api/analytics?id=<id>     → { proposal, events, views }  one proposal's timeline
 *
 * The rows carry no link token, passphrase or draft content beyond the
 * contact's name; the link itself is in `proposal` only for editors and above.
 */
import { db, rest } from '../lib/db.js';
import { onlyMethods, noStore } from '../lib/http.js';
import { requireRole, atLeast } from '../lib/accounts.js';
import { summary } from '../lib/proposals.js';
import { overview, search, serviceNames } from '../lib/overview.js';
import { DOC_TYPES } from '../assets/js/schema.js';
import { UUID_RE } from '../lib/tokens.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';
import { getRetention } from '../lib/retention.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['GET'])) return;
  const d = db();
  const who = await requireRole(req, res, d, 'viewer');
  if (!who) return;
  const q = req.query || {};

  if (typeof q.q === 'string') {
    if (await rateLimited(d, req, `search:${who.email}`, 120, 60)) { tooMany(res); return; }
    const ids = await search(d, q.q);
    if (!ids) { res.status(503).json({ error: 'Search is not available. Try again.' }); return; }
    res.status(200).json({ ids });
    return;
  }

  if (q.id !== undefined) {
    const id = String(q.id);
    const proposal = UUID_RE.test(id) ? await summary(d, id, { withLink: atLeast(who.role, 'editor') }) : null;
    if (!proposal) { res.status(404).json({ error: 'No such proposal.' }); return; }
    const [revs, events, views] = await Promise.all([
      rest(d, 'GET', `texc_proposal_revisions?proposal_id=eq.${id}&select=id,rev_label`),
      rest(d, 'GET', `texc_events?proposal_id=eq.${id}&select=id,revision_id,event,session,actor,meta,created_at&order=created_at.desc,id.desc&limit=500`),
      rest(d, 'GET', `texc_proposal_views?proposal_id=eq.${id}&select=revision_id,session,device,region,created_at&order=created_at.desc&limit=500`),
    ]);
    if (!revs.ok || !events.ok || !views.ok) { res.status(503).json({ error: 'The history could not be loaded.' }); return; }
    const label = new Map(revs.json.map((r) => [r.id, r.rev_label]));
    res.status(200).json({
      proposal,
      events: events.json.map(({ revision_id: rid, ...e }) => ({ ...e, rev: label.get(rid) || null })),
      views: views.json.map(({ revision_id: rid, ...v }) => ({ ...v, rev: label.get(rid) || null })),
    });
    return;
  }

  const [rows, retention] = await Promise.all([overview(d), getRetention(d)]);
  if (!rows) { res.status(503).json({ error: 'The dashboard could not be loaded.' }); return; }
  res.status(200).json({ now: new Date().toISOString(), role: who.role, rows, services: serviceNames(), docTypes: DOC_TYPES,
    retention: { archiveAfterDays: retention.archiveAfterDays, keepAcceptedYears: retention.keepAcceptedYears } });
}

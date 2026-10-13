/**
 * GET /api/export?state=&region=&service=&sort=&q=  → the dashboard's list as CSV.
 *
 * Editors and above. The same rows, filters and rules as the screen
 * (assets/js/lifecycle.js), so the file says what the list said. Every export
 * is recorded in the staff audit with its filters and row count: it is data
 * leaving the system. Same-site only — a link on another site cannot make a
 * signed-in browser export.
 */
import { db } from '../lib/db.js';
import { onlyMethods, refuseCrossSite } from '../lib/http.js';
import { requireRole } from '../lib/accounts.js';
import { recordAudit } from '../lib/events.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';
import { listRows, STATES, SORTS } from '../assets/js/lifecycle.js';
import { toCsv, csvName } from '../lib/report.js';
import { BRAND } from '../lib/brand.js';
import { overview, search, serviceNames } from '../lib/overview.js';

export const config = { maxDuration: 15 };

const pick = (v, ok) => (typeof v === 'string' && ok(v) ? v : '');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (onlyMethods(req, res, ['GET']) || refuseCrossSite(req, res)) return;
  const d = db();
  const who = await requireRole(req, res, d, 'editor');
  if (!who) return;
  if (await rateLimited(d, req, `export:${who.email}`, 30, 3600)) { tooMany(res); return; }
  const q = req.query || {};
  const f = {
    state: pick(q.state, (v) => v === 'followup' || !!STATES[v]),
    region: pick(q.region, (v) => v.length <= 60),
    service: pick(q.service, (v) => /^[a-z0-9-]{1,40}$/.test(v)),
    sort: pick(q.sort, (v) => !!SORTS[v]) || 'activity',
    ids: null,
  };
  const words = typeof q.q === 'string' ? q.q.trim().slice(0, 200) : '';
  const rows = await overview(d);
  const ids = words ? await search(d, words) : [];
  if (!rows || !ids) { res.status(503).json({ error: 'The export could not be built. Try again.' }); return; }
  if (words) f.ids = new Set(ids);
  const now = new Date();
  const list = listRows(rows, f, now);
  const logged = await recordAudit(d, req, who, 'exported', { detail: { rows: list.length, filters: { ...f, ids: undefined, q: words || undefined } } });
  if (!logged) { res.status(503).json({ error: 'The export could not be recorded, so it was not made.' }); return; }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvName(BRAND.name, now)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(toCsv(list, { services: serviceNames() }));
}

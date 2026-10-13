/**
 * The editor's working copy.
 *
 *   GET /api/drafts?id=<proposal>                      → { config, version, updated_at, updated_by, proposal }
 *   PUT /api/drafts { id, version, config, force? }    → { version, updated_at }
 *                                                         409 { version, updated_by, updated_at } if someone saved first
 *
 * Saves are conditional on the version the editor loaded (version=eq.<n>), so
 * two people editing at once can never silently overwrite each other. "Keep
 * mine" (force) is an explicit choice, and it is audited.
 */
import { db, rest } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole } from '../lib/accounts.js';
import { getDraft, summary, guardSafety } from '../lib/proposals.js';
import { recordAudit } from '../lib/events.js';
import { UUID_RE } from '../lib/tokens.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 10 };
const MAX_BYTES = 1_000_000;

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['GET', 'PUT'])) return;
  const d = db();
  const who = await requireRole(req, res, d, 'editor');
  if (!who) return;

  if (req.method === 'GET') {
    const id = String((req.query || {}).id || '');
    const draft = UUID_RE.test(id) ? await getDraft(d, id) : null;
    if (!draft) { res.status(404).json({ error: 'No such proposal.' }); return; }
    res.status(200).json({ ...draft, proposal: await summary(d, id) });
    return;
  }

  if (refuseCrossSite(req, res)) return;
  if (await rateLimited(d, req, `drafts:${who.email}`, 120, 60)) { tooMany(res); return; }
  const b = body(req, MAX_BYTES + 10_000);
  const id = String(b.id || '');
  const version = Number(b.version);
  if (!UUID_RE.test(id) || !Number.isInteger(version) || !b.config || typeof b.config !== 'object' || Array.isArray(b.config)) {
    res.status(400).json({ error: 'That save was not understood.' });
    return;
  }
  if (Buffer.byteLength(JSON.stringify(b.config)) > MAX_BYTES) { res.status(413).json({ error: 'This proposal is over 1 MB. Remove something large and try again.' }); return; }

  // Safety lines: refused below administrator, stamped and recorded at administrator.
  const stored = await getDraft(d, id);
  if (!stored) { res.status(404).json({ error: 'No such proposal.' }); return; }
  const safety = guardSafety(who, stored.config, b.config);
  if (!safety.ok) { res.status(403).json({ error: safety.error }); return; }
  if (safety.changed.length) await recordAudit(d, req, who, 'safety_unlocked', { proposalId: id, detail: { services: safety.changed } });

  const now = new Date().toISOString();
  let r = await rest(d, 'PATCH', `texc_drafts?proposal_id=eq.${id}&version=eq.${version}`, { config: b.config, version: version + 1, updated_at: now, updated_by: who.email });
  if (r.ok && Array.isArray(r.json) && r.json.length === 1) { res.status(200).json({ version: version + 1, updated_at: now }); return; }
  if (!r.ok) { res.status(503).json({ error: 'Saving failed. Your changes are still here; it will try again.' }); return; }

  // Nothing matched: someone saved first (or the proposal does not exist).
  const current = await getDraft(d, id);
  if (!current) { res.status(404).json({ error: 'No such proposal.' }); return; }
  if (b.force === true) {
    r = await rest(d, 'PATCH', `texc_drafts?proposal_id=eq.${id}&version=eq.${current.version}`, { config: b.config, version: current.version + 1, updated_at: now, updated_by: who.email });
    if (r.ok && r.json && r.json.length === 1) {
      await recordAudit(d, req, who, 'draft_overwritten', { proposalId: id, detail: { overwrote: current.updated_by, theirVersion: current.version } });
      res.status(200).json({ version: current.version + 1, updated_at: now });
      return;
    }
  }
  res.status(409).json({ error: 'conflict', version: current.version, updated_by: current.updated_by, updated_at: current.updated_at });
}

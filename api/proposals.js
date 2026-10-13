/**
 * Proposals, for staff.
 *
 *   GET  /api/proposals                         → { proposals: [...] }   (editor+)
 *   GET  /api/proposals?id=<id>                 → summary: status, link, revisions
 *   GET  /api/proposals?id=<id>&changes=1       → what publishing now would change, by section
 *   POST { action: 'create', config }           → { id }                (editor+)
 *   POST { action: 'publish', id, version, changeNote, emailClient }   (editor+; params and unlocked safety lines: admin)
 *   POST { action: 'withdraw', id, note }       (admin)
 *   POST { action: 'rotate', id }               (admin) new link and passphrase
 *   POST { action: 'passphrase', id }           (admin) read back, audited
 */
import { db, rest } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole, atLeast } from '../lib/accounts.js';
import { createProposal, publish, withdraw, rotate, readPassphrase, summary, changesSince } from '../lib/proposals.js';
import { UUID_RE } from '../lib/tokens.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['GET', 'POST'])) return;
  const d = db();
  const who = await requireRole(req, res, d, 'editor');
  if (!who) return;

  if (req.method === 'GET') {
    const id = String((req.query || {}).id || '');
    if (id && (req.query || {}).changes === '1') {
      const changes = UUID_RE.test(id) ? await changesSince(d, id) : null;
      res.status(200).json({ changes });
      return;
    }
    if (id) {
      const s = UUID_RE.test(id) ? await summary(d, id) : null;
      if (!s) { res.status(404).json({ error: 'No such proposal.' }); return; }
      res.status(200).json(s);
      return;
    }
    const r = await rest(d, 'GET', 'texc_proposals?select=id,reference,project,client_company,site_locality,status,updated_at,issued_at&order=updated_at.desc&limit=200');
    if (!r.ok) { res.status(503).json({ error: 'The list could not be loaded.' }); return; }
    res.status(200).json({ proposals: r.json });
    return;
  }

  if (refuseCrossSite(req, res)) return;
  const b = body(req, 1_100_000);
  const action = String(b.action || '');
  const id = String(b.id || '');
  if (action !== 'create' && !UUID_RE.test(id)) { res.status(400).json({ error: 'Which proposal?' }); return; }
  const admin = () => {
    if (atLeast(who.role, 'admin')) return true;
    res.status(403).json({ error: 'Only an administrator can do this.' });
    return false;
  };
  const answer = (out) => {
    if (out.ok) { const { ok, ...rest2 } = out; res.status(200).json(rest2); return; }
    res.status(out.status || 500).json({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
  };

  if (action === 'create') {
    if (await rateLimited(d, req, `create:${who.email}`, 20, 3600)) { tooMany(res); return; }
    const cfg = b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? b.config : {};
    const newId = await createProposal(d, who, cfg);
    if (!newId) { res.status(503).json({ error: 'The proposal could not be created.' }); return; }
    res.status(200).json({ id: newId });
    return;
  }
  if (action === 'publish') {
    if (await rateLimited(d, req, `publish:${who.email}`, 20, 600)) { tooMany(res); return; }
    answer(await publish(d, req, { ...who }, id, { version: b.version, changeNote: b.changeNote, emailClient: b.emailClient === true }));
    return;
  }
  if (action === 'withdraw') { if (!admin()) return; answer(await withdraw(d, req, who, id, b.note)); return; }
  if (action === 'rotate') {
    if (!admin()) return;
    if (await rateLimited(d, req, `rotate:${who.email}`, 5, 3600)) { tooMany(res); return; }
    answer(await rotate(d, req, who, id));
    return;
  }
  if (action === 'passphrase') {
    if (!admin()) return;
    if (await rateLimited(d, req, `passphrase:${who.email}`, 10, 3600)) { tooMany(res); return; }
    answer(await readPassphrase(d, req, who, id));
    return;
  }
  res.status(400).json({ error: 'Unknown action.' });
}

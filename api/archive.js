/**
 * The archive, staff side (lib/archive.js says what it is; docs/architecture.md §20).
 *
 *   POST { action: 'search', q, year, service, region, proposal } → { rows, years, services, regions, retention, role } (viewer+)
 *   POST { action: 'revision', id }                       → { config, media, facts }          (viewer+)
 *   POST { action: 'file', revision, card, download }     → { url, name, bytes, sha256 }      (viewer+, 60 s)
 *   POST { action: 'pack', proposal }                     → { pack }                          (editor+, audited)
 *   POST { action: 'retention' }                          → { retention, limits }             (viewer+)
 *   POST { action: 'retention-set', archiveAfterDays, keepAcceptedYears } → { retention }     (admin, audited)
 *
 * Everything here is read from what was published, never from a draft. A
 * file is reached by (revision, card) through that revision's own snapshot.
 * Every refusal is to staff, so it says why.
 */
import { db } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole, atLeast } from '../lib/accounts.js';
import { recordAudit } from '../lib/events.js';
import { searchArchive, archiveYears, staffRevision, revisionFileLink, packManifest } from '../lib/archive.js';
import { getRetention, cleanRetention, setRetention, LIMITS } from '../lib/retention.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';
import { serviceNames } from '../lib/overview.js';
import { templateData } from '../lib/template-data.js';

export const config = { maxDuration: 30 };
const MIN_ROLE = { pack: 'editor', 'retention-set': 'admin' };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST']) || refuseCrossSite(req, res)) return;
  const d = db();
  const who = await requireRole(req, res, d, 'viewer');
  if (!who) return;
  const b = body(req, 10_000);
  const action = String(b.action || '');
  const fail = (status, error) => res.status(status).json({ error });
  if (MIN_ROLE[action] && !atLeast(who.role, MIN_ROLE[action])) {
    fail(403, action === 'pack' ? 'Only an editor or an administrator can download a record pack.' : 'Only an administrator can change the keeping periods.');
    return;
  }

  if (action === 'search') {
    const [rows, years, retention] = await Promise.all([searchArchive(d, b), archiveYears(d), getRetention(d)]);
    if (!rows || !years) { fail(503, 'The archive could not be read. Try again.'); return; }
    res.status(200).json({ rows, years, services: serviceNames(), regions: templateData().regions || [], retention, role: who.role });
    return;
  }

  if (action === 'revision') {
    const out = await staffRevision(d, b.id);
    if (!out) { fail(404, 'No such revision.'); return; }
    res.status(200).json(out);
    return;
  }

  if (action === 'file') {
    if (await rateLimited(d, req, 'archive-file', 120, 60)) { tooMany(res); return; }
    const link = await revisionFileLink(d, b.revision, b.card, { download: b.download === true });
    if (!link) { fail(404, 'That revision did not send that document, or its file could not be reached.'); return; }
    res.status(200).json(link);
    return;
  }

  if (action === 'pack') {
    const pack = await packManifest(d, b.proposal);
    if (!pack) { fail(404, 'No such proposal, or its records could not be read.'); return; }
    // Recorded before anything is handed over: who took a copy of the whole record, and when.
    const logged = await recordAudit(d, req, who, 'record_pack_requested', { proposalId: pack.proposal.id, target: pack.proposal.reference || pack.proposal.id,
      detail: { revisions: pack.revisions.length, acceptances: pack.acceptances.length } });
    if (!logged) { fail(503, 'The request could not be recorded, so the pack was not prepared. Try again.'); return; }
    res.status(200).json({ pack, by: who.email });
    return;
  }

  if (action === 'retention') {
    res.status(200).json({ retention: await getRetention(d), limits: LIMITS });
    return;
  }

  if (action === 'retention-set') {
    const { value, error } = cleanRetention(b);
    if (error) { fail(400, error); return; }
    const out = await setRetention(d, req, who, value);
    if (!out.ok) { fail(out.status, out.error); return; }
    res.status(200).json({ retention: out.retention, limits: LIMITS });
    return;
  }

  fail(400, 'Unknown action.');
}

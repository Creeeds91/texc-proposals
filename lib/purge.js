/**
 * Deleting an archived proposal for good: the one way anything in this system
 * is deleted (docs/architecture.md §18).
 *
 *   - Brand in Black only (a super), never TEXC's own administrators
 *   - only 90 days after it was archived; and once accepted, only after the
 *     keeping period TEXC sets (Phase 9, lib/retention.js) has run from its
 *     last acceptance. Unset, an acceptance is a business record kept for good
 *   - only by typing its reference (or DELETE for one never issued)
 *
 * The staff audit records what is about to go BEFORE anything goes — that
 * entry is all that remains afterwards. texc_purge() then removes the rows in
 * one transaction (the only caller of the triggers' purge flag), and the
 * stored photographs, documents and records go last, bucket by bucket. Files
 * that could not be removed are recorded too, never silently left.
 */
import { rpc, one, rest } from './db.js';
import { recordAudit } from './events.js';
import { listPaths, remove, MEDIA_BUCKET, ATTACH_BUCKET, ACCEPT_BUCKET } from './storage.js';
import { PURGE_AFTER_DAYS, purgeableFrom, keptUntil, dayLabel } from '../assets/js/lifecycle.js';
import { getRetention } from './retention.js';

export const confirmWord = (prop) => prop.reference || 'DELETE';

export async function purge(d, req, who, id, confirm) {
  if (who.role !== 'super') return { ok: false, status: 403, error: 'Only Brand in Black can delete a proposal permanently.' };
  const prop = await one(d, `texc_proposals?id=eq.${id}&select=id,reference,project,client_company,status,created_at,issued_at,archived_at,archived_by,archive_reason`);
  if (!prop) return { ok: false, status: 404, error: 'No such proposal.' };
  if (!prop.archived_at) return { ok: false, status: 409, error: 'Only an archived proposal can be deleted permanently.' };
  const from = purgeableFrom(prop);
  if (Date.now() < from.getTime()) return { ok: false, status: 409, error: `It can be deleted from ${dayLabel(from)}, ${PURGE_AFTER_DAYS} days after it was archived.` };
  const accepted = await rest(d, 'GET', `texc_acceptances?proposal_id=eq.${id}&select=accepted_at`);
  if (!accepted.ok || !Array.isArray(accepted.json)) return { ok: false, status: 503, error: 'It could not be checked. Nothing was removed.' };
  if (accepted.json.length) {
    const until = keptUntil(accepted.json.map((a) => a.accepted_at), await getRetention(d));
    if (!until) return { ok: false, status: 409, error: 'It was accepted. An accepted proposal is a business record and is kept.' };
    if (Date.now() < until.getTime()) return { ok: false, status: 409, error: `It was accepted, so it is kept until ${dayLabel(until)}, the end of its keeping period.` };
  }
  if (String(confirm || '').trim() !== confirmWord(prop)) return { ok: false, status: 400, error: `Type ${prop.reference ? 'its reference' : 'DELETE'} exactly to confirm.` };

  const { id: _id, ...facts } = prop;
  const logged = await recordAudit(d, req, who, 'proposal_purged', { proposalId: id, target: prop.reference, detail: facts });
  if (!logged) return { ok: false, status: 503, error: 'The deletion could not be recorded, so nothing was deleted.' };
  const r = await rpc(d, 'texc_purge', { p: { proposal_id: id, reference: prop.reference || '' } });
  if (!r.ok) {
    await recordAudit(d, req, who, 'proposal_purge_refused', { proposalId: id, target: prop.reference });
    return { ok: false, status: r.status === 409 ? 409 : 503, error: 'It could not be deleted. Nothing was removed.' };
  }

  const left = [];
  let files = 0;
  for (const bucket of [MEDIA_BUCKET, ATTACH_BUCKET, ACCEPT_BUCKET]) {
    const paths = await listPaths(bucket, `proposals/${id}`);
    if (paths === null) { left.push({ bucket, reason: 'could not be listed' }); continue; }
    if (!paths.length) continue;
    if (await remove(bucket, paths)) files += paths.length;
    else left.push({ bucket, reason: 'could not be removed', paths });
  }
  if (left.length) await recordAudit(d, req, who, 'proposal_purge_files_left', { proposalId: id, target: prop.reference, detail: { left } });
  return { ok: true, removed: { ...r.json, stored: files }, filesLeft: left.length > 0 };
}

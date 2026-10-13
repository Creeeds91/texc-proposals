/**
 * Attachments, staff side (lib/attachments.js says how a file goes up).
 *
 *   POST { action: 'list',     proposal }                       → { files: [...] }          (editor+)
 *   POST { action: 'begin',    proposal, name, bytes, sha256 }  → { uploadUrl } | { file }  (editor+)
 *   POST { action: 'verify',   proposal, name, sha256 }         → { file } | 422 { finding } (editor+)
 *   POST { action: 'override', proposal, id, reason }           → { file }                  (admin, audited)
 *   POST { action: 'url',      proposal, id, download }         → { url, name }             (editor+, 60 s)
 *
 * Only staff ever upload. A client reaches a file through api/attachment.js,
 * and only one a published revision offered them.
 */
import { db, rest } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole, atLeast } from '../lib/accounts.js';
import { getProposal } from '../lib/proposals.js';
import { recordEvent, recordAudit } from '../lib/events.js';
import { signUpload, signUrl, ATTACH_BUCKET } from '../lib/storage.js';
import {
  MAX_BYTES, PER_PROPOSAL, SHA_RE, cleanName, attachmentPath, forEditor, listFiles, getFile, findBySha, verifyUpload,
} from '../lib/attachments.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST']) || refuseCrossSite(req, res)) return;
  const d = db();
  const who = await requireRole(req, res, d, 'editor');
  if (!who) return;
  const b = body(req, 20_000);
  const action = String(b.action || '');
  const pid = String(b.proposal || '');
  const prop = await getProposal(d, pid);
  if (!prop) { res.status(404).json({ error: 'No such proposal.' }); return; }
  const fail = (status, error, extra = {}) => res.status(status).json({ error, ...extra });

  if (action === 'list') {
    const rows = await listFiles(d, pid);
    if (!rows) { fail(503, 'The files could not be listed.'); return; }
    res.status(200).json({ files: rows.map(forEditor) });
    return;
  }

  if (action === 'begin' || action === 'verify') {
    // Each step counted on its own: a verify reads up to 25 MB back and checks it.
    if (await rateLimited(d, req, `attach-${action}:${who.email}`, 100, 600)) { tooMany(res); return; }
    const sha = String(b.sha256 || '');
    const name = cleanName(b.name);
    if (!SHA_RE.test(sha)) { fail(400, 'That upload was not understood.'); return; }
    if (!/\.pdf$/i.test(name)) { fail(400, 'Only PDF files can be attached.'); return; }

    if (action === 'begin') {
      const size = Number(b.bytes);
      if (!Number.isSafeInteger(size) || size <= 0) { fail(400, 'That upload was not understood.'); return; }
      if (size > MAX_BYTES) { fail(413, 'That file is larger than 25 MB.'); return; }
      const existing = await findBySha(d, pid, sha);
      if (existing) { res.status(200).json({ file: forEditor(existing) }); return; }
      const rows = await listFiles(d, pid);
      if (!rows) { fail(503, 'The files could not be listed.'); return; }
      if (rows.length >= PER_PROPOSAL) { fail(409, `A proposal can carry up to ${PER_PROPOSAL} files.`); return; }
      const uploadUrl = await signUpload(ATTACH_BUCKET, attachmentPath(pid, sha, name));
      if (!uploadUrl) { fail(503, 'The upload could not be started. Try again.'); return; }
      res.status(200).json({ uploadUrl });
      return;
    }

    const out = await verifyUpload(d, who, pid, sha, name);
    if (!out.ok) { fail(out.status, out.error, out.finding ? { finding: out.finding } : {}); return; }
    await recordEvent(d, { proposalId: pid, event: 'attachment_added', actor: who.email, meta: { file: out.file.id, name: out.file.original_name, status: out.file.scan_status } });
    res.status(200).json({ file: forEditor(out.file) });
    return;
  }

  const id = String(b.id || '');
  const row = await getFile(d, pid, id);
  if (!row) { fail(404, 'No such file.'); return; }

  if (action === 'override') {
    if (!atLeast(who.role, 'admin')) { fail(403, 'Only an administrator can release a file the check did not pass.'); return; }
    const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (reason.length < 10) { fail(400, 'Say why it is safe to send, in a sentence.'); return; }
    if (!(row.scan_detail && row.scan_detail.overridable === true) || !['rejected', 'cannot-verify'].includes(row.scan_status)) {
      fail(409, 'This file cannot be released.');
      return;
    }
    // The record is the control: no audit entry, no release.
    const logged = await recordAudit(d, req, who, 'attachment_released', { proposalId: pid, target: row.id, detail: { name: row.original_name, was: row.scan_status, reasons: row.scan_detail.reasons || [], reason } });
    if (!logged) { fail(503, 'The release could not be recorded, so it was not made.'); return; }
    const r = await rest(d, 'PATCH', `texc_attachments?id=eq.${row.id}&scan_status=in.(rejected,cannot-verify)&select=id`, { scan_status: 'override', override_by: who.email, override_reason: reason });
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) { fail(409, 'This file changed in the meantime. Reload it.'); return; }
    res.status(200).json({ file: forEditor({ ...row, scan_status: 'override', override_by: who.email, override_reason: reason }) });
    return;
  }

  if (action === 'url') {
    if (await rateLimited(d, req, `attach-url:${who.email}`, 60, 60)) { tooMany(res); return; }
    const download = b.download === true;
    const url = await signUrl(ATTACH_BUCKET, row.storage_path, 60, { downloadName: download ? row.original_name : '' });
    if (!url) { fail(503, 'The file could not be opened. Try again.'); return; }
    res.status(200).json({ url, name: row.original_name, bytes: Number(row.bytes) || 0 });
    return;
  }

  fail(400, 'That request was not understood.');
}

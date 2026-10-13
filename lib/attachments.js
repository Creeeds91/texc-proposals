/**
 * The PDFs attached to a proposal (docs/architecture.md §5).
 *
 * A file goes up in three steps, so a 25 MB PDF never passes through a
 * function (Vercel accepts 4.5 MB):
 *
 *   1. begin   the editor names the file's SHA-256 and size; the server fixes
 *              its path and answers a one-off upload URL (or the row, if this
 *              proposal already has that exact file)
 *   2. upload  the browser PUTs the bytes straight to the private bucket; the
 *              bucket itself refuses anything over 25 MB or not a PDF
 *   3. verify  the server reads the stored bytes back, checks they are the
 *              file that was named, runs the structural check
 *              (lib/pdf-inspect.js) and records the result
 *
 * Paths are content-addressed — proposals/<id>/attachments/<sha256[:16]>-<name>.pdf
 * — and never overwritten, so a published revision's snapshot always points
 * at the bytes it was published with. A file that can never be served (not a
 * PDF, encrypted, a "zip bomb") is deleted at verify and leaves no row; one an
 * administrator could still release (active content, "cannot verify") is
 * kept with its findings until they do or someone uploads a better copy.
 */
import { rest, one } from './db.js';
import { inspectPdf, MAX_BYTES } from './pdf-inspect.js';
import { download, remove, ATTACH_BUCKET } from './storage.js';
import { UUID_RE } from './tokens.js';

export { MAX_BYTES };
export const PER_PROPOSAL = 20;
export const SHA_RE = /^[a-f0-9]{64}$/;
export const RELEASED = new Set(['clean', 'override']);
const COLUMNS = 'id,proposal_id,storage_path,original_name,sha256,bytes,pages,scan_status,scan_detail,scanned_at,override_by,override_reason,uploaded_by,created_at';

/** A file name as staff gave it, made safe to show and to store under. */
export function cleanName(raw) {
  const base = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/^.*[\\/]/, '').trim().slice(0, 160);
  return base || 'document.pdf';
}

export function attachmentPath(proposalId, sha, name) {
  const stem = cleanName(name).replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
  return `proposals/${proposalId}/attachments/${sha.slice(0, 16)}-${stem}.pdf`;
}

/** What the editor is told about a file. Never the storage path. */
export function forEditor(row) {
  const detail = row.scan_detail || {};
  return {
    id: row.id, name: row.original_name, sha256: row.sha256, bytes: Number(row.bytes) || 0, pages: row.pages,
    status: row.scan_status, reasons: Array.isArray(detail.reasons) ? detail.reasons : [], overridable: detail.overridable === true,
    overrideBy: row.override_by || null, overrideReason: row.override_reason || null,
    scannedAt: row.scanned_at, uploadedBy: row.uploaded_by, createdAt: row.created_at,
  };
}

export async function listFiles(d, proposalId) {
  if (!UUID_RE.test(String(proposalId || ''))) return null;
  const r = await rest(d, 'GET', `texc_attachments?proposal_id=eq.${proposalId}&archived_at=is.null&select=${COLUMNS}&order=created_at`);
  return r.ok && Array.isArray(r.json) ? r.json : null;
}

export async function getFile(d, proposalId, id) {
  if (!UUID_RE.test(String(proposalId || '')) || !UUID_RE.test(String(id || ''))) return null;
  return one(d, `texc_attachments?id=eq.${id}&proposal_id=eq.${proposalId}&archived_at=is.null&select=${COLUMNS}`);
}

const findBySha = (d, proposalId, sha) => one(d, `texc_attachments?proposal_id=eq.${proposalId}&sha256=eq.${sha}&select=${COLUMNS}`);

/** The checklist's view of the files: { id: { status, name, pages, bytes } }. */
export function filesContext(rows) {
  return Object.fromEntries((rows || []).map((r) => [r.id, { status: r.scan_status, name: r.original_name, pages: r.pages, bytes: Number(r.bytes) || 0 }]));
}

/**
 * Step 3. Reads the stored file back and records what the check found.
 * Returns { ok: true, file } | { ok: false, status, error, finding? }.
 */
export async function verifyUpload(d, who, proposalId, sha, name) {
  const existing = await findBySha(d, proposalId, sha);
  if (existing) return { ok: true, file: existing };
  const path = attachmentPath(proposalId, sha, name);
  const got = await download(ATTACH_BUCKET, path, MAX_BYTES);
  if (got.tooLarge) { await remove(ATTACH_BUCKET, [path]); return { ok: false, status: 413, error: 'That file is larger than 25 MB.' }; }
  if (!got.ok) return { ok: false, status: got.status === 400 || got.status === 404 ? 404 : 503, error: got.status === 400 || got.status === 404 ? 'The upload did not arrive. Try again.' : 'The file could not be read back. Try again.' };
  const finding = inspectPdf(got.bytes);
  if (finding.sha256 !== sha) { await remove(ATTACH_BUCKET, [path]); return { ok: false, status: 400, error: 'The file that arrived is not the one that was named. Try again.' }; }
  const detail = { reasons: finding.reasons, overridable: finding.overridable, checker: 'structural-v1' };
  if (finding.status === 'rejected' && !finding.overridable) {
    // Nothing anyone could decide would make this servable: keep nothing.
    await remove(ATTACH_BUCKET, [path]);
    return { ok: false, status: 422, error: 'That file cannot be attached.', finding: { status: 'rejected', reasons: finding.reasons, overridable: false } };
  }
  const r = await rest(d, 'POST', `texc_attachments?on_conflict=proposal_id,sha256&select=${COLUMNS}`, {
    proposal_id: proposalId, storage_path: path, original_name: cleanName(name), sha256: sha, bytes: finding.bytes,
    pages: finding.pages || null, scan_status: finding.status, scan_detail: detail, scanned_at: new Date().toISOString(),
    source: 'upload', uploaded_by: who.email,
  }, { prefer: 'return=representation,resolution=ignore-duplicates' });
  if (!r.ok) return { ok: false, status: 503, error: 'The check result could not be saved. Try again.' };
  const row = (Array.isArray(r.json) && r.json[0]) || await findBySha(d, proposalId, sha);
  return row ? { ok: true, file: row } : { ok: false, status: 503, error: 'The check result could not be saved. Try again.' };
}

export { findBySha };

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
 * Paths are content-addressed by the WHOLE SHA-256 —
 * proposals/<id>/attachments/<sha256>-<name>.pdf — and never overwritten, so a
 * path belongs to exactly one file and a published revision's snapshot always
 * points at the bytes it was published with. (Until 14 Oct 2026 the path held
 * only the first 16 characters, which let one file's path be named for
 * another; the security review found it.) A stored file that a record points
 * at is never deleted here, whatever a request says. A file that can never be served (not a
 * PDF, encrypted, a "zip bomb") is deleted at verify and leaves no row; one an
 * administrator could still release (active content, "cannot verify") is
 * kept with its findings until they do or someone uploads a better copy.
 */
import { rest, one } from './db.js';
import { inspectPdf, MAX_BYTES } from './pdf-inspect.js';
import { download, remove, listPaths, listObjects, ATTACH_BUCKET } from './storage.js';
import { UUID_RE } from './tokens.js';

export { MAX_BYTES };
export const PER_PROPOSAL = 20;
/** Stored files a proposal may hold at once, checked or still waiting to be: room to replace each, and no more. */
export const STORED_CAP = PER_PROPOSAL * 2;
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
  return `proposals/${proposalId}/attachments/${sha}-${stem}.pdf`;
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

/** Delete a stored upload only if no record points at it. Answers whether it was free to go. */
async function removeUnrecorded(d, path) {
  const r = await rest(d, 'GET', `texc_attachments?storage_path=eq.${encodeURIComponent(path)}&select=id&limit=1`);
  if (!r.ok || !Array.isArray(r.json) || r.json.length) return false;
  return remove(ATTACH_BUCKET, [path]);
}

/** An upload link lasts two hours; an upload younger than that may still be on its way. */
export const UPLOAD_GRACE_MS = (120 + 10) * 60 * 1000;

/**
 * Remove a proposal's stored uploads that no record points at (begun, never
 * checked) and that are older than any upload link could be. A file being
 * checked is claimed by a pending record first (verifyUpload), so it is never
 * swept from under its check; nor is one whose age is not known.
 */
export async function sweepUnrecorded(d, proposalId, { minAgeMs = UPLOAD_GRACE_MS } = {}) {
  const items = await listObjects(ATTACH_BUCKET, `proposals/${proposalId}/attachments`);
  const now = Date.now();
  for (const it of items || []) {
    if (!it.createdAt || now - Date.parse(it.createdAt) < minAgeMs) continue;
    await removeUnrecorded(d, it.path);
  }
}

/** How many files are stored for a proposal, checked or not; null when they could not be counted. */
export async function storedCount(proposalId) {
  const paths = await listPaths(ATTACH_BUCKET, `proposals/${proposalId}/attachments`);
  return paths === null ? null : paths.length;
}

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
  if (existing && existing.scan_status !== 'pending') return { ok: true, file: existing };
  const path = existing ? existing.storage_path : attachmentPath(proposalId, sha, name);
  // Claim the path BEFORE reading it: a pending record means no sweep can
  // remove the file while it is being checked (the second review, 14 Oct 2026).
  if (!existing) {
    const claim = await rest(d, 'POST', 'texc_attachments?on_conflict=proposal_id,sha256', {
      proposal_id: proposalId, storage_path: path, original_name: cleanName(name), sha256: sha, bytes: 0,
      scan_status: 'pending', scan_detail: {}, source: 'upload', uploaded_by: who.email,
    }, { prefer: 'return=minimal,resolution=ignore-duplicates' });
    if (!claim.ok) return { ok: false, status: 503, error: 'The file could not be checked. Try again.' };
  }
  const pending = `texc_attachments?proposal_id=eq.${proposalId}&sha256=eq.${sha}&scan_status=eq.pending`;
  const unclaim = () => rest(d, 'DELETE', pending, undefined, { prefer: 'return=minimal' });
  const got = await download(ATTACH_BUCKET, path, MAX_BYTES);
  if (got.tooLarge) { await unclaim(); await removeUnrecorded(d, path); return { ok: false, status: 413, error: 'That file is larger than 25 MB.' }; }
  if (!got.ok) { await unclaim(); return { ok: false, status: got.status === 400 || got.status === 404 ? 404 : 503, error: got.status === 400 || got.status === 404 ? 'The upload did not arrive. Try again.' : 'The file could not be read back. Try again.' }; }
  const finding = inspectPdf(got.bytes);
  if (finding.sha256 !== sha) { await unclaim(); await removeUnrecorded(d, path); return { ok: false, status: 400, error: 'The file that arrived is not the one that was named. Try again.' }; }
  const detail = { reasons: finding.reasons, overridable: finding.overridable, checker: 'structural-v2' };
  if (finding.status === 'rejected' && !finding.overridable) {
    // Nothing anyone could decide would make this servable: keep nothing.
    await unclaim();
    await removeUnrecorded(d, path);
    return { ok: false, status: 422, error: 'That file cannot be attached.', finding: { status: 'rejected', reasons: finding.reasons, overridable: false } };
  }
  const r = await rest(d, 'PATCH', `${pending}&select=${COLUMNS}`, {
    bytes: finding.bytes, pages: finding.pages || null, scan_status: finding.status, scan_detail: detail, scanned_at: new Date().toISOString(),
  });
  if (!r.ok) return { ok: false, status: 503, error: 'The check result could not be saved. Try again.' };
  // A second check of the same file that finished first has already recorded it.
  const row = (Array.isArray(r.json) && r.json[0]) || await findBySha(d, proposalId, sha);
  return row && row.scan_status !== 'pending' ? { ok: true, file: row } : { ok: false, status: 503, error: 'The check result could not be saved. Try again.' };
}

export { findBySha };

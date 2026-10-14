/**
 * The document library, staff side (lib/library.js says what it is).
 *
 *   POST { action: 'list' }                                          → { items, people, kinds, currencies }   (viewer+)
 *   POST { action: 'url',      id, version, download }               → { url, name, bytes }                   (viewer+, 60 s)
 *   POST { action: 'create',   ownerKind, ownerRef, kind, title, issuer, number, docCode, currency } → { item } (admin, audited)
 *   POST { action: 'update',   id, ...the same facts }               → { item }                               (admin, audited)
 *   POST { action: 'begin',    id, name, bytes, sha256 }             → { uploadUrl } | { version }            (admin)
 *   POST { action: 'verify',   id, name, sha256 }                    → { version } | 422 { finding }          (admin)
 *   POST { action: 'approve',  id, version, docRev, docDate, issuedOn, expiresOn } → { item }               (admin, audited)
 *   POST { action: 'override', id, version, reason }                 → { item }                               (admin, audited)
 *   POST { action: 'discard',  id, version }                         → { item }                               (admin)
 *   POST { action: 'remove',   id }                                  → { removed: true }                      (admin, audited)
 *   POST { action: 'retire' | 'restore', id }                        → { item }                               (admin, audited)
 *
 * Only an administrator adds to the library, and a file is offered to a
 * proposal only once an administrator has approved it with its facts. An
 * approved file never changes and is never deleted (the database refuses);
 * a document is retired, not deleted, once it has had one. Every refusal
 * here is to staff, so it says why.
 */
import { db, rest } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole, atLeast } from '../lib/accounts.js';
import { recordAudit } from '../lib/events.js';
import { signUpload, signUrl, remove, ATTACH_BUCKET } from '../lib/storage.js';
import { MAX_BYTES, SHA_RE, cleanName, sweepFolder, storedIn, removeUnrecorded } from '../lib/attachments.js';
import {
  KINDS, CURRENCIES, VERSIONS_PER_ITEM, libraryFolder, libraryPath, cleanItemFacts, cleanVersionFacts, itemForStaff,
  getItem, getVersion, versionsOf, loadLibrary, verifyLibraryUpload, currentOf,
} from '../lib/library.js';
import { hobartToday } from '../lib/projection.js';
import { templateData } from '../lib/template-data.js';
import { rateLimited, tooMany } from '../lib/ratelimit.js';

export const config = { maxDuration: 30 };
const ADMIN_ACTIONS = new Set(['create', 'update', 'begin', 'verify', 'approve', 'override', 'discard', 'remove', 'retire', 'restore']);

const people = () => (templateData().people || []).map((p) => ({ slug: p.slug, name: p.name }));

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['POST']) || refuseCrossSite(req, res)) return;
  const d = db();
  const who = await requireRole(req, res, d, 'viewer');
  if (!who) return;
  const b = body(req, 20_000);
  const action = String(b.action || '');
  const fail = (status, error, extra = {}) => res.status(status).json({ error, ...extra });
  if (ADMIN_ACTIONS.has(action) && !atLeast(who.role, 'admin')) { fail(403, 'Only an administrator can change the document library.'); return; }

  if (action === 'list') {
    const lib = await loadLibrary(d);
    if (!lib) { fail(503, 'The library could not be read.'); return; }
    res.status(200).json({
      items: lib.items.map((i) => itemForStaff(i, lib.versions.get(i.id), lib.usage[i.id])),
      people: people(), kinds: KINDS, currencies: CURRENCIES, today: hobartToday(),
    });
    return;
  }

  if (action === 'create') {
    const { facts, error } = cleanItemFacts(b, people());
    if (error) { fail(400, error); return; }
    const r = await rest(d, 'POST', 'texc_evidence', { ...facts, created_by: who.email });
    const item = r.ok && Array.isArray(r.json) ? r.json[0] : null;
    if (!item) { fail(503, 'The document could not be added. Try again.'); return; }
    await recordAudit(d, req, who, 'library_document_added', { target: item.id, detail: { title: item.title, kind: item.kind, owner: item.owner_ref || 'organisation' } });
    res.status(200).json({ item: itemForStaff(item, [], null) });
    return;
  }

  const id = String(b.id || '');
  const item = await getItem(d, id);
  if (!item) { fail(404, 'No such document in the library.'); return; }
  const answerItem = async (status = 200) => {
    const fresh = await getItem(d, id);
    const versions = await versionsOf(d, id);
    if (!fresh || !versions) { fail(503, 'The library could not be read.'); return; }
    res.status(status).json({ item: itemForStaff(fresh, versions, null) });
  };
  if (item.retired_at && ['update', 'begin', 'verify', 'approve', 'override'].includes(action)) { fail(409, 'This document is retired. Restore it to change it.'); return; }

  if (action === 'update') {
    const { facts, error } = cleanItemFacts(b, people(), { partial: true });
    if (error) { fail(400, error); return; }
    if (!Object.keys(facts).length) { fail(400, 'Nothing to change.'); return; }
    const logged = await recordAudit(d, req, who, 'library_document_changed', { target: id, detail: { title: item.title, changed: Object.keys(facts) } });
    if (!logged) { fail(503, 'The change could not be recorded, so it was not made.'); return; }
    const r = await rest(d, 'PATCH', `texc_evidence?id=eq.${id}&select=id`, facts);
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) { fail(503, 'The change could not be saved. Try again.'); return; }
    await answerItem();
    return;
  }

  if (action === 'begin' || action === 'verify') {
    if (await rateLimited(d, req, `library-${action}:${who.email}`, 60, 600)) { tooMany(res); return; }
    const sha = String(b.sha256 || '');
    const name = cleanName(b.name);
    if (!SHA_RE.test(sha)) { fail(400, 'That upload was not understood.'); return; }
    if (!/\.pdf$/i.test(name)) { fail(400, 'Only PDF files can go in the library.'); return; }
    if (action === 'begin') {
      const size = Number(b.bytes);
      if (!Number.isSafeInteger(size) || size <= 0) { fail(400, 'That upload was not understood.'); return; }
      if (size > MAX_BYTES) { fail(413, 'That file is larger than 25 MB.'); return; }
      const versions = await versionsOf(d, id);
      if (!versions) { fail(503, 'The library could not be read.'); return; }
      const known = versions.find((v) => v.sha256 === sha && v.scan_status !== 'pending');
      if (known) { await answerItem(); return; }
      // Uploads begun and never checked still take room; when it is full, those go first.
      let stored = await storedIn(libraryFolder(id));
      if (stored !== null && stored >= VERSIONS_PER_ITEM) { await sweepFolder(d, libraryFolder(id)); stored = await storedIn(libraryFolder(id)); }
      if (stored === null) { fail(503, 'The upload could not be started. Try again.'); return; }
      if (stored >= VERSIONS_PER_ITEM) { fail(409, `This document already holds ${stored} files. Discard the ones that were never approved.`); return; }
      const uploadUrl = await signUpload(ATTACH_BUCKET, libraryPath(id, sha, name));
      if (!uploadUrl) { fail(503, 'The upload could not be started. Try again.'); return; }
      res.status(200).json({ uploadUrl });
      return;
    }
    const out = await verifyLibraryUpload(d, who, id, sha, name);
    if (!out.ok) { fail(out.status, out.error, out.finding ? { finding: out.finding } : {}); return; }
    await answerItem();
    return;
  }

  if (action === 'retire' || action === 'restore') {
    const retire = action === 'retire';
    if (retire === !!item.retired_at) { await answerItem(); return; }
    const logged = await recordAudit(d, req, who, retire ? 'library_document_retired' : 'library_document_restored', { target: id, detail: { title: item.title } });
    if (!logged) { fail(503, 'The change could not be recorded, so it was not made.'); return; }
    const r = await rest(d, 'PATCH', `texc_evidence?id=eq.${id}&select=id`, retire ? { retired_at: new Date().toISOString(), retired_by: who.email } : { retired_at: null, retired_by: null });
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) { fail(503, 'The change could not be saved. Try again.'); return; }
    await answerItem();
    return;
  }

  if (action === 'remove') {
    // Only a document that never had an approved file and is offered nowhere; the database refuses the rest.
    const versions = await versionsOf(d, id);
    if (!versions) { fail(503, 'The library could not be read.'); return; }
    if (versions.some((v) => v.approved_at)) { fail(409, 'This document has had an approved file, so it is kept. Retire it instead.'); return; }
    const used = await rest(d, 'GET', `texc_drafts?config->attachments=cs.${encodeURIComponent(JSON.stringify([{ evidence: id }]))}&select=proposal_id&limit=1`);
    if (!used.ok || !Array.isArray(used.json)) { fail(503, 'The library could not be read.'); return; }
    if (used.json.length) { fail(409, 'A proposal offers this document. Remove it from that proposal first.'); return; }
    const logged = await recordAudit(d, req, who, 'library_document_removed', { target: id, detail: { title: item.title } });
    if (!logged) { fail(503, 'The removal could not be recorded, so it was not made.'); return; }
    const gone = await rest(d, 'DELETE', `texc_evidence_versions?evidence_id=eq.${id}&approved_at=is.null`, undefined, { prefer: 'return=minimal' });
    const r = gone.ok ? await rest(d, 'DELETE', `texc_evidence?id=eq.${id}&select=id`) : gone;
    if (!r.ok) { fail(409, 'This document could not be removed. Retire it instead.'); return; }
    if (versions.length) await remove(ATTACH_BUCKET, versions.map((v) => v.storage_path));
    res.status(200).json({ removed: true });
    return;
  }

  const version = await getVersion(d, id, String(b.version || ''));
  if (!version) { fail(404, 'No such file on this document.'); return; }

  if (action === 'url') {
    if (await rateLimited(d, req, `library-url:${who.email}`, 60, 60)) { tooMany(res); return; }
    if (version.scan_status === 'pending') { fail(409, 'This file has not been checked yet.'); return; }
    const download = b.download === true;
    const url = await signUrl(ATTACH_BUCKET, version.storage_path, 60, { downloadName: download ? version.original_name : '' });
    if (!url) { fail(503, 'The file could not be opened. Try again.'); return; }
    res.status(200).json({ url, name: version.original_name, bytes: Number(version.bytes) || 0 });
    return;
  }

  if (version.approved_at) { fail(409, 'This file is approved, and an approved file is never changed. Upload a new version instead.'); return; }

  if (action === 'override') {
    const reason = String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (reason.length < 10) { fail(400, 'Say why it is safe to send, in a sentence.'); return; }
    if (!(version.scan_detail && version.scan_detail.overridable === true) || !['rejected', 'cannot-verify'].includes(version.scan_status)) { fail(409, 'This file cannot be released.'); return; }
    // The record is the control: no audit entry, no release.
    const logged = await recordAudit(d, req, who, 'library_file_released', { target: version.id, detail: { document: item.title, name: version.original_name, was: version.scan_status, reasons: version.scan_detail.reasons || [], reason } });
    if (!logged) { fail(503, 'The release could not be recorded, so it was not made.'); return; }
    const r = await rest(d, 'PATCH', `texc_evidence_versions?id=eq.${version.id}&scan_status=in.(rejected,cannot-verify)&approved_at=is.null&select=id`, { scan_status: 'override', override_by: who.email, override_reason: reason });
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) { fail(409, 'This file changed in the meantime. Reload it.'); return; }
    await answerItem();
    return;
  }

  if (action === 'discard') {
    const r = await rest(d, 'DELETE', `texc_evidence_versions?id=eq.${version.id}&approved_at=is.null&select=id`);
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) { fail(409, 'This file changed in the meantime. Reload it.'); return; }
    await removeUnrecorded(d, version.storage_path);
    await answerItem();
    return;
  }

  if (action === 'approve') {
    if (!['clean', 'override'].includes(version.scan_status)) { fail(409, 'Only a file that passed the check, or that an administrator released, can be approved.'); return; }
    const { facts, error } = cleanVersionFacts(b);
    if (error) { fail(400, error); return; }
    const today = hobartToday();
    if (item.currency === 'expires') {
      if (!facts.expires_on) { fail(400, 'This document expires: give the date it expires.'); return; }
      if (facts.expires_on < today) { fail(400, 'That date has passed. Approve the renewed document instead.'); return; }
    } else facts.expires_on = null;
    const before = currentOf(await versionsOf(d, id) || []);
    const logged = await recordAudit(d, req, who, 'library_file_approved', { target: version.id, detail: {
      document: item.title, name: version.original_name, sha256: version.sha256, released: version.scan_status === 'override',
      docRev: facts.doc_rev, expiresOn: facts.expires_on, replaces: before ? before.id : null,
    } });
    if (!logged) { fail(503, 'The approval could not be recorded, so it was not made.'); return; }
    const r = await rest(d, 'PATCH', `texc_evidence_versions?id=eq.${version.id}&approved_at=is.null&select=id`, { ...facts, approved_by: who.email, approved_at: new Date().toISOString() });
    if (!r.ok || !Array.isArray(r.json) || !r.json.length) { fail(409, 'This file changed in the meantime. Reload it.'); return; }
    await answerItem();
    return;
  }

  fail(400, 'That request was not understood.');
}

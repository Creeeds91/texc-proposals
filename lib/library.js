/**
 * The document library (Phase 8, docs/architecture.md §19): standing documents
 * uploaded once and offered on any proposal. The company's (policies,
 * procedures, SWMS, its insurance) and each person's (licences,
 * qualifications, their own insurance), in one table with an owner, as the
 * TEXC app's EvidenceItem, so the library can move there unchanged.
 *
 * A library document has versions. A new file goes up exactly as a
 * proposal's does (lib/attachments.js verifyStored: claimed, read back,
 * checked), into library/<document id>/<sha256>-<name>.pdf, then an
 * administrator gives it its facts and approves it. The current version is
 * the latest approved. Once approved a version is a record (the database
 * refuses to change or delete it), because a revision that sent it points at
 * its path. Publishing freezes the current version into the revision's
 * snapshot, so approving a renewed certificate changes what the NEXT revision
 * sends, never what an earlier one sent.
 */
import { rest, one, rpc } from './db.js';
import { UUID_RE } from './tokens.js';
import { cleanName, fileStem, verifyStored, RELEASED } from './attachments.js';
import { currentVersion as currentOf } from './projection.js';

/** George's own filename prefixes (the TEXC app plan, "A classification already in use"). */
export const KINDS = Object.freeze([['compliance', 'Compliance'], ['insurance', 'Insurance'], ['procedure', 'Procedure'], ['project', 'Project'], ['ssds', 'SSDS']]);
const KIND_SET = new Set(KINDS.map(([k]) => k));
/** Whether a document lapses. The model also has 'project' (lives for one job); the library offers these two. */
export const CURRENCIES = Object.freeze([['permanent', 'Does not expire'], ['expires', 'Expires on a date']]);
const CURRENCY_SET = new Set(CURRENCIES.map(([c]) => c));
/** Files a library document may hold at once, approved or still waiting. */
export const VERSIONS_PER_ITEM = 20;

const ITEM_COLUMNS = 'id,owner_kind,owner_ref,kind,title,issuer,number,doc_code,currency,created_by,created_at,updated_at,retired_at,retired_by';
export const VERSION_COLUMNS = 'id,evidence_id,storage_path,original_name,sha256,bytes,pages,scan_status,scan_detail,scanned_at,override_by,override_reason,doc_rev,doc_date,issued_on,expires_on,uploaded_by,created_at,approved_by,approved_at';
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SLUG = /^[a-z0-9-]{1,60}$/;

export const libraryFolder = (itemId) => `library/${itemId}`;
export const libraryPath = (itemId, sha, name) => `${libraryFolder(itemId)}/${sha}-${fileStem(name)}.pdf`;

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const date = (v) => (v === null || v === undefined || v === '' ? null : (DATE.test(String(v)) ? String(v) : undefined));

/** The current version: the latest approved. One rule, kept with publishing. */
export { currentOf };

/**
 * A library document's facts as staff gave them, made safe; `people` is the
 * website's team list ([{ slug }]). Returns { facts } or { error }.
 */
export function cleanItemFacts(b, people, { partial = false } = {}) {
  const facts = {};
  if (!partial || b.ownerKind !== undefined || b.ownerRef !== undefined) {
    const ownerKind = String(b.ownerKind || '');
    if (ownerKind === 'organisation') { facts.owner_kind = ownerKind; facts.owner_ref = ''; }
    else if (ownerKind === 'person') {
      const ref = String(b.ownerRef || '');
      if (!SLUG.test(ref) || !(people || []).some((p) => p.slug === ref)) return { error: 'Choose whose document it is.' };
      facts.owner_kind = ownerKind; facts.owner_ref = ref;
    } else return { error: 'Choose whose document it is.' };
  }
  if (!partial || b.kind !== undefined) {
    if (!KIND_SET.has(String(b.kind || ''))) return { error: 'Choose what kind of document it is.' };
    facts.kind = String(b.kind);
  }
  if (!partial || b.title !== undefined) {
    facts.title = text(b.title, 160);
    if (!facts.title) return { error: 'Give the document a title.' };
  }
  if (!partial || b.currency !== undefined) {
    if (!CURRENCY_SET.has(String(b.currency || ''))) return { error: 'Say whether it expires.' };
    facts.currency = String(b.currency);
  }
  for (const [key, col, max] of [['issuer', 'issuer', 160], ['number', 'number', 80], ['docCode', 'doc_code', 60]]) {
    if (!partial || b[key] !== undefined) facts[col] = text(b[key], max);
  }
  return { facts };
}

/** A version's facts: revision, date, issued and expiry dates. Returns { facts } or { error }. */
export function cleanVersionFacts(b) {
  const facts = { doc_rev: text(b.docRev, 20) };
  for (const [key, col, label] of [['docDate', 'doc_date', 'document date'], ['issuedOn', 'issued_on', 'issue date'], ['expiresOn', 'expires_on', 'expiry date']]) {
    const v = date(b[key]);
    if (v === undefined) return { error: `The ${label} is not a date.` };
    facts[col] = v;
  }
  if (facts.issued_on && facts.expires_on && facts.expires_on < facts.issued_on) return { error: 'It cannot expire before it was issued.' };
  return { facts };
}

/** What staff are told about a version. Never its storage path. */
export function versionForStaff(v) {
  const detail = v.scan_detail || {};
  return {
    id: v.id, name: v.original_name, sha256: v.sha256, bytes: Number(v.bytes) || 0, pages: v.pages,
    status: v.scan_status, reasons: Array.isArray(detail.reasons) ? detail.reasons : [], overridable: detail.overridable === true,
    overrideBy: v.override_by || null, overrideReason: v.override_reason || null,
    docRev: v.doc_rev || '', docDate: v.doc_date || null, issuedOn: v.issued_on || null, expiresOn: v.expires_on || null,
    uploadedBy: v.uploaded_by, createdAt: v.created_at, approvedBy: v.approved_by || null, approvedAt: v.approved_at || null,
  };
}

/** What staff are told about a library document, with its versions (newest first) and where it is used. */
export function itemForStaff(item, versions, usage) {
  const cur = currentOf(versions);
  return {
    id: item.id, ownerKind: item.owner_kind, ownerRef: item.owner_ref, kind: item.kind, title: item.title,
    issuer: item.issuer, number: item.number, docCode: item.doc_code, currency: item.currency,
    createdBy: item.created_by, createdAt: item.created_at, updatedAt: item.updated_at,
    retiredAt: item.retired_at || null, retiredBy: item.retired_by || null,
    current: cur ? versionForStaff(cur) : null,
    versions: [...(versions || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(versionForStaff),
    usage: { revisions: 0, proposals: 0, drafts: 0, ...(usage || {}) },
  };
}

export async function getItem(d, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return one(d, `texc_evidence?id=eq.${id}&select=${ITEM_COLUMNS}`);
}

export async function getVersion(d, itemId, versionId) {
  if (!UUID_RE.test(String(itemId || '')) || !UUID_RE.test(String(versionId || ''))) return null;
  return one(d, `texc_evidence_versions?id=eq.${versionId}&evidence_id=eq.${itemId}&select=${VERSION_COLUMNS}`);
}

export async function versionsOf(d, itemId) {
  const r = await rest(d, 'GET', `texc_evidence_versions?evidence_id=eq.${itemId}&select=${VERSION_COLUMNS}&order=created_at`);
  return r.ok && Array.isArray(r.json) ? r.json : null;
}

/** The whole library: { items, versions: Map<item id, rows>, usage } or null. */
export async function loadLibrary(d, { usage = true } = {}) {
  const [items, versions, used] = await Promise.all([
    rest(d, 'GET', `texc_evidence?select=${ITEM_COLUMNS}&order=title`),
    rest(d, 'GET', `texc_evidence_versions?select=${VERSION_COLUMNS}&order=created_at`),
    usage ? rpc(d, 'texc_evidence_usage', {}) : Promise.resolve({ ok: true, json: {} }),
  ]);
  if (!items.ok || !versions.ok || !Array.isArray(items.json) || !Array.isArray(versions.json)) return null;
  const by = new Map(items.json.map((i) => [i.id, []]));
  for (const v of versions.json) if (by.has(v.evidence_id)) by.get(v.evidence_id).push(v);
  return { items: items.json, versions: by, usage: used.ok && used.json && typeof used.json === 'object' ? used.json : {} };
}

/**
 * The library documents a config's cards point at, for publishing:
 * { <item id>: { item, versions } }. Ids that are not in the library are left out.
 */
export async function evidenceFor(d, cfg) {
  const ids = [...new Set((Array.isArray(cfg?.attachments) ? cfg.attachments : []).map((a) => a && a.evidence).filter((x) => UUID_RE.test(String(x || ''))))];
  if (!ids.length) return {};
  const [items, versions] = await Promise.all([
    rest(d, 'GET', `texc_evidence?id=in.(${ids.join(',')})&select=${ITEM_COLUMNS}`),
    rest(d, 'GET', `texc_evidence_versions?evidence_id=in.(${ids.join(',')})&select=${VERSION_COLUMNS}`),
  ]);
  if (!items.ok || !versions.ok || !Array.isArray(items.json) || !Array.isArray(versions.json)) return null;
  return Object.fromEntries(items.json.map((i) => [i.id, { item: i, versions: versions.json.filter((v) => v.evidence_id === i.id) }]));
}

/**
 * The checklist's view of the library (assets/js/checks.js ctx.evidence):
 * { <item id>: { title, retired, current: { status, expiresOn } | null } }.
 * The editor builds the same shape from the list it was sent.
 */
export function evidenceContext(map) {
  return Object.fromEntries(Object.entries(map || {}).map(([id, { item, versions }]) => {
    const cur = currentOf(versions);
    return [id, { title: item.title, retired: !!item.retired_at, current: cur ? { status: cur.scan_status, expiresOn: cur.expires_on || null } : null }];
  }));
}

/** Step 3 for a library file. */
export function verifyLibraryUpload(d, who, itemId, sha, name) {
  return verifyStored(d, who, {
    table: 'texc_evidence_versions', ownerCol: 'evidence_id', ownerId: itemId, sha, name,
    path: libraryPath(itemId, sha, cleanName(name)), columns: VERSION_COLUMNS,
  });
}

/** A version that may be sent: approved, and its file passed the check or was released. */
export const sendable = (v) => !!(v && v.approved_at && RELEASED.has(v.scan_status));

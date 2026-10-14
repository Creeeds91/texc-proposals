/**
 * The archive (Phase 9, docs/architecture.md §20): every revision ever sent,
 * found by its proposal or its documents; any one of them opened by staff
 * exactly as it was sent; and the record pack's manifest.
 *
 * Everything comes from what was published — the revision's own text and
 * snapshot — never from the draft or the library as they are now. Storage
 * paths never leave the server: a file is reached by (revision, card), signed
 * for 60 seconds.
 */
import { rest, one, rpc } from './db.js';
import { UUID_RE } from './tokens.js';
import { signUrl, signUrls, ATTACH_BUCKET, MEDIA_BUCKET } from './storage.js';
import { mediaPath } from './proposals.js';
import { getRetention } from './retention.js';
import { acceptanceFor, publicSummary } from './acceptances.js';

const CARD_RE = /^[a-z0-9-]{1,40}$/i;

/** A revision's documents as the client saw them, with the fingerprints of the files behind them. */
function documentsOf(row) {
  const files = new Map((Array.isArray(row.files) ? row.files : []).map((f) => [f.card, f]));
  return (Array.isArray(row.documents) ? row.documents : []).filter((a) => a && (a.visibility === 'client' || a.visibility === 'on-request')).map((a) => {
    const f = files.get(a.id) || {};
    return {
      card: a.id, title: a.title || '', category: a.category || 'other', visibility: a.visibility,
      docCode: a.docCode || '', docRev: a.docRev || '', docDate: a.docDate || null, expiresOn: a.expiresOn || null,
      sha256: f.sha256 || null, bytes: Number(f.bytes) || null, pages: Number.isInteger(f.pages) ? f.pages : null, library: !!f.evidence,
    };
  });
}

/** One row per revision, newest first. Filters: q, year, service, region, proposal. */
export async function searchArchive(d, f = {}) {
  const p = {};
  for (const k of ['q', 'year', 'service', 'region', 'proposal']) if (f[k]) p[k] = String(f[k]).slice(0, 200);
  p.limit = 300;
  const r = await rpc(d, 'texc_archive', { p });
  if (!r.ok || !Array.isArray(r.json)) return null;
  return r.json.map((row) => ({
    proposalId: row.proposal_id, reference: row.reference, project: row.project, client: row.client_company,
    locality: row.site_locality, region: row.site_region, services: row.services || [], docType: row.doc_type,
    archivedAt: row.archived_at, archiveReason: row.archive_reason, practice: row.is_test === true, status: row.status,
    revisionId: row.revision_id, rev: row.rev_label, publishedAt: row.published_at, publishedBy: row.published_by,
    supersededAt: row.superseded_at, withdrawnAt: row.withdrawn_at, current: row.current === true, note: row.change_note || '',
    templateVersion: row.template_version,
    acceptance: row.acceptance ? { id: row.acceptance.id, name: row.acceptance.name, company: row.acceptance.company, acceptedAt: row.acceptance.accepted_at, kind: row.acceptance.kind } : null,
    documents: documentsOf(row),
  }));
}

/** The years anything was published in, newest first (for the archive's year filter). */
export async function archiveYears(d) {
  const r = await rest(d, 'GET', 'texc_proposal_revisions?select=published_at&order=published_at.asc&limit=1');
  if (!r.ok || !Array.isArray(r.json)) return null;
  const now = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', year: 'numeric' }).format(new Date()));
  if (!r.json.length) return [now];
  const first = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', year: 'numeric' }).format(new Date(r.json[0].published_at)));
  const years = [];
  for (let y = now; y >= first; y -= 1) years.push(y);
  return years;
}

const REV_COLUMNS = 'id,proposal_id,rev_index,rev_label,published_text,plaintext_sha256,enc_sha256,template_version,attachments_snapshot,change_note,published_at,published_by,superseded_at,withdrawn_at';

/** A revision for staff to see as sent: its config (less the sealed view token), photographs signed for an hour, and its facts. */
export async function staffRevision(d, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const rev = await one(d, `texc_proposal_revisions?id=eq.${id}&select=${REV_COLUMNS}`);
  if (!rev) return null;
  const prop = await one(d, `texc_proposals?id=eq.${rev.proposal_id}&select=id,reference,project,client_company,current_revision_id,archived_at,status`);
  const acc = await acceptanceFor(d, id);
  let config;
  try { config = JSON.parse(rev.published_text); } catch { return null; }
  delete config.__vt;
  const wanted = [];
  for (const [mid, m] of Object.entries(config.media || {})) {
    for (const w of (m && m.widths) || []) wanted.push([mid, w, mediaPath(rev.proposal_id, mid, w, m.type)]);
  }
  const urls = wanted.length ? await signUrls(MEDIA_BUCKET, wanted.map((x) => x[2]), 3600) : {};
  const media = {};
  for (const [mid, w, path] of wanted) if (urls[path]) (media[mid] ||= { srcset: [] }).srcset.push([w, urls[path]]);
  return {
    config, media,
    facts: {
      proposalId: rev.proposal_id, reference: prop && prop.reference, project: prop && prop.project, client: prop && prop.client_company,
      revisionId: rev.id, rev: rev.rev_label, publishedAt: rev.published_at, publishedBy: rev.published_by,
      supersededAt: rev.superseded_at, withdrawnAt: rev.withdrawn_at, current: !!prop && prop.current_revision_id === rev.id,
      archivedAt: prop && prop.archived_at, templateVersion: rev.template_version, plaintextSha256: rev.plaintext_sha256,
      acceptance: acc ? publicSummary(acc, rev.rev_label) : null,
    },
  };
}

/** A 60-second link to one document a revision sent, from that revision's snapshot. */
export async function revisionFileLink(d, revisionId, card, { download = false } = {}) {
  if (!UUID_RE.test(String(revisionId || '')) || !CARD_RE.test(String(card || ''))) return null;
  const rev = await one(d, `texc_proposal_revisions?id=eq.${revisionId}&select=attachments_snapshot`);
  const entry = rev && Array.isArray(rev.attachments_snapshot) ? rev.attachments_snapshot.find((x) => x && x.card === card) : null;
  if (!entry || typeof entry.path !== 'string') return null;
  const url = await signUrl(ATTACH_BUCKET, entry.path, 60, { downloadName: download ? entry.name : '' });
  return url ? { url, name: entry.name, bytes: Number(entry.bytes) || 0, sha256: entry.sha256 } : null;
}

/**
 * Everything a record pack holds, for the browser to fetch and fingerprint:
 * the proposal's facts, each revision's exact published text with the
 * fingerprints recorded at publishing, the documents each sent (fetched one by
 * one through revisionFileLink), each acceptance with the fingerprint written
 * when its record was stored, and the whole history. No link token,
 * passphrase or storage path.
 */
export async function packManifest(d, proposalId) {
  if (!UUID_RE.test(String(proposalId || ''))) return null;
  const prop = await one(d, `texc_proposals?id=eq.${proposalId}&select=id,reference,project,client_company,site_locality,site_region,services,doc_type,status,issued_at,valid_until,accepted_at,archived_at,archived_by,archive_reason,created_at,created_by`);
  if (!prop) return null;
  const [revs, accs, events, views, audit] = await Promise.all([
    rest(d, 'GET', `texc_proposal_revisions?proposal_id=eq.${proposalId}&select=${REV_COLUMNS}&order=rev_index`),
    rest(d, 'GET', `texc_acceptances?proposal_id=eq.${proposalId}&select=id,revision_id,kind,accepted_at,name,position,company,email,terms_version,signature_kind,accepted_total_cents,plaintext_sha256,record_sha256,recorded_by,staff_note&order=accepted_at`),
    rest(d, 'GET', `texc_events?proposal_id=eq.${proposalId}&select=id,revision_id,event,session,actor,meta,created_at&order=created_at,id&limit=5000`),
    rest(d, 'GET', `texc_proposal_views?proposal_id=eq.${proposalId}&select=revision_id,session,device,region,created_at&order=created_at&limit=5000`),
    rest(d, 'GET', `texc_staff_audit?proposal_id=eq.${proposalId}&select=actor,role,action,target,detail,at&order=at,id&limit=2000`),
  ]);
  if (![revs, accs, events, views, audit].every((r) => r.ok && Array.isArray(r.json))) return null;
  const label = new Map(revs.json.map((r) => [r.id, r.rev_label]));
  return {
    proposal: prop,
    retention: await getRetention(d),
    revisions: revs.json.map((r) => ({
      id: r.id, rev: r.rev_label, publishedAt: r.published_at, publishedBy: r.published_by, supersededAt: r.superseded_at, withdrawnAt: r.withdrawn_at,
      note: r.change_note || '', templateVersion: r.template_version, plaintextSha256: r.plaintext_sha256, encSha256: r.enc_sha256,
      published: r.published_text,
      documents: (Array.isArray(r.attachments_snapshot) ? r.attachments_snapshot : []).map((x) => ({ card: x.card, title: x.title || '', name: x.name || '', sha256: x.sha256, bytes: Number(x.bytes) || 0, library: !!x.evidence })),
    })),
    acceptances: accs.json.map((a) => ({ ...a, rev: label.get(a.revision_id) || null })),
    events: events.json.map(({ revision_id: rid, ...e }) => ({ ...e, rev: label.get(rid) || null })),
    views: views.json.map(({ revision_id: rid, ...v }) => ({ ...v, rev: label.get(rid) || null })),
    audit: audit.json.map(({ at, ...x }) => ({ ...x, created_at: at })),
  };
}

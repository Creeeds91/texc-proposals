/**
 * The proposal lifecycle on the server: create, publish, rotate, withdraw,
 * read a passphrase back. Endpoints in api/ check who is asking and call these.
 *
 * Publishing, in order (docs/architecture.md §1):
 *   1. the draft the editor last saw (its version) is the one published
 *   2. the shared checklist (assets/js/checks.js) must say ready — the same
 *      rules the editor showed, so nothing passes there that fails here
 *   3. a reference is claimed (first publish only; kept forever)
 *   4. toPublished() builds the client's copy by allowlist; the bytes are
 *      checked once more for CONFIRM, hashed, and encrypted
 *   5. texc_publish() writes the revision, supersedes the last one and
 *      repoints the proposal in ONE transaction, or nothing at all
 */
import { BRAND } from './brand.js';
import { rest, rpc, one, enc } from './db.js';
import { seal, open } from './vault.js';
import { encryptRevision, rewrap } from './envelope.js';
import { newPassphrase } from './passphrase.js';
import { linkToken, viewToken, sha256, slug as newSlug, UUID_RE } from './tokens.js';
import { toPublished, assertClean, hobartToday, revLabel, Unpublishable } from './projection.js';
import { recordEvent, recordAudit } from './events.js';
import { sendEmail, layout } from './notify-email.js';
import { runChecks } from '../assets/js/checks.js';
import { visibleSections, SECTIONS, DOC_TYPES } from '../assets/js/schema.js';
import { templateData, TEMPLATE_VERSION } from './template-data.js';
import { listFiles, filesContext } from './attachments.js';
import { acceptancesOf } from './acceptances.js';

export { Unpublishable };
export const LINK_GRACE_DAYS = 30; // C2: link expiry is valid-until + this, until TEXC sets a period

export function baseUrl() {
  return String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}
export const proposalUrl = (slug, token) => `${baseUrl()}/p/${slug}?t=${token}`;

export const mediaPath = (proposalId, id, width, type) => `proposals/${proposalId}/media/${id}-${width}.${type === 'image/jpeg' ? 'jpg' : 'webp'}`;

export async function getProposal(d, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return one(d, `texc_proposals?id=eq.${id}&select=id,slug,reference,project,client_company,status,current_revision_id,access_token,passphrase_enc,issued_at,link_expires_at,first_opened_at,last_opened_at,open_count,archived_at,archived_by,archive_reason,is_test`);
}

export async function getDraft(d, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return one(d, `texc_drafts?proposal_id=eq.${id}&select=config,version,updated_at,updated_by,base_revision_id`);
}

/**
 * Website safety lines are compliance wording: only an administrator may unlock
 * or reword one, and the server — not the browser — records who. Returning a
 * line to the website wording is open to anyone. Mutates `after` to stamp the
 * administrator; answers { ok, changed: [slugs] } or { ok: false, error }.
 */
export function guardSafety(who, before, after) {
  const isAdmin = who.role === 'admin' || who.role === 'super';
  const prev = new Map(((before && before.scope && before.scope.services) || []).map((s) => [s && s.slug, s || {}]));
  const services = after && after.scope && Array.isArray(after.scope.services) ? after.scope.services : [];
  const changed = [];
  for (const s of services) {
    if (!s || typeof s !== 'object') continue;
    const p = prev.get(s.slug) || {};
    const unlockedNow = !!(s.safetyUnlockedBy || s.safety);
    const same = (p.safetyUnlockedBy || null) === (s.safetyUnlockedBy || null) && (p.safety || null) === (s.safety || null);
    if (same || !unlockedNow) continue;
    if (!isAdmin) return { ok: false, error: 'Only an administrator can unlock or reword a safety line.' };
    s.safetyUnlockedBy = who.email;
    changed.push(s.slug);
  }
  return { ok: true, changed };
}

/** A new proposal and its empty draft. */
export async function createProposal(d, who, config) {
  // The reference, revision and issue date are the server's to set at publish;
  // a config started from the demo or an export must not carry them in.
  if (config && config.meta) { for (const k of ['reference', 'rev', 'issueDate', 'supersededBy', 'currentHref']) delete config.meta[k]; }
  delete config?.acks;
  // An imported or demo config never brings an unlock with it; an administrator unlocks in the editor.
  for (const s of (config && config.scope && Array.isArray(config.scope.services) ? config.scope.services : [])) { if (s) { delete s.safetyUnlockedBy; delete s.safety; } }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await rest(d, 'POST', 'texc_proposals', { slug: newSlug(), created_by: who.email, ...listingFields(config) });
    if (r.ok && r.json && r.json[0]) {
      const id = r.json[0].id;
      const dr = await rest(d, 'POST', 'texc_drafts', { proposal_id: id, config: config || {}, updated_by: who.email }, { prefer: 'return=minimal' });
      if (!dr.ok) return null;
      await recordEvent(d, { proposalId: id, event: 'created', actor: who.email });
      return id;
    }
    if (r.status !== 409) return null; // a slug collision retries; anything else is a failure
  }
  return null;
}

/**
 * What the dashboard lists and searches a proposal by, from a draft. Written
 * at every publish (so it matches what was sent) and on each save while the
 * proposal has never been issued. search_extra holds the words that are not
 * columns of their own: document type, services, contact, document titles.
 */
export function listingFields(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const services = (Array.isArray(c.scope?.services) ? c.scope.services : []).map((s) => s && s.slug).filter((s) => typeof s === 'string').slice(0, 20);
  const names = new Map(templateData().services.map((s) => [s.slug, s.name]));
  const docType = typeof c.meta?.docType === 'string' && DOC_TYPES[c.meta.docType] ? c.meta.docType : 'shotfiring';
  const titles = (Array.isArray(c.attachments) ? c.attachments : []).map((a) => str(a && a.title, 120));
  return {
    project: str(c.meta?.project, 200), site_locality: str(c.meta?.siteLocality, 120), site_region: str(c.meta?.siteRegion, 60),
    client_company: str(c.client?.company, 200), services, doc_type: docType,
    search_extra: [DOC_TYPES[docType], ...services.map((s) => names.get(s) || s), str(c.client?.contactName, 160), ...titles].filter(Boolean).join(' ').slice(0, 4000),
  };
}

function linkExpiry(validUntil) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(validUntil || '')) ? new Date(`${validUntil}T13:59:59Z`) : new Date();
  return new Date(base.getTime() + LINK_GRACE_DAYS * 86400000).toISOString();
}

export const checkContext = () => {
  const T = templateData();
  return { today: hobartToday(), services: T.services, register: T.register, brand: BRAND.name };
};

/**
 * Publish the draft at `version`. Returns { ok, ...result } or { ok: false, status, error, detail }.
 */
export async function publish(d, req, who, id, { version, changeNote = '', emailClient = false } = {}) {
  let prop = await getProposal(d, id);
  const draft = prop && await getDraft(d, id);
  if (!prop || !draft) return { ok: false, status: 404, error: 'No such proposal.' };
  if (prop.archived_at) return { ok: false, status: 409, error: 'This proposal is archived. Restore it before publishing.' };
  if (Number(version) !== draft.version) {
    return { ok: false, status: 409, error: 'The draft changed since you opened the checklist. Look it over and publish again.', detail: { version: draft.version, updated_by: draft.updated_by } };
  }
  const cfg = draft.config || {};
  const fileRows = await listFiles(d, id);
  if (!fileRows) return { ok: false, status: 503, error: 'The attached files could not be read. Nothing was published.' };

  // The same rules the editor applies, on the files and acceptance as the server holds them.
  const acceptedNow = prop.current_revision_id ? (await acceptancesOf(d, id)).find((x) => x.revision_id === prop.current_revision_id) : null;
  const acceptedLabel = acceptedNow ? (await one(d, `texc_proposal_revisions?id=eq.${prop.current_revision_id}&select=rev_label`))?.rev_label : null;
  const checks = runChecks(cfg, { ...checkContext(), files: filesContext(fileRows),
    accepted: acceptedNow ? { rev: acceptedLabel, name: acceptedNow.name, acceptedAt: acceptedNow.accepted_at } : null });
  if (!checks.ready) {
    return { ok: false, status: 422, error: 'The checklist is not complete.', detail: { blockers: checks.blockers, acks: checks.acks.filter((a) => !a.done) } };
  }
  const visible = new Set(visibleSections(cfg));
  const isAdmin = who.role === 'admin' || who.role === 'super';
  if (visible.has('params') && !isAdmin) return { ok: false, status: 403, error: 'Only an administrator can publish blast parameters (Q9).' };
  const unlocked = (cfg.scope?.services || []).filter((s) => s.safetyUnlockedBy);
  if (unlocked.length && !isAdmin) return { ok: false, status: 403, error: 'A proposal with an unlocked safety line must be published by an administrator.' };

  // A withdrawn proposal comes back only through an administrator, and only
  // behind a NEW link and passphrase: the old link must not quietly open again.
  let rotated = null;
  if (prop.status === 'withdrawn') {
    if (!isAdmin) return { ok: false, status: 403, error: 'This proposal was withdrawn. Only an administrator can issue it again, and it gets a new link and passphrase.' };
    rotated = await rotate(d, req, who, id);
    if (!rotated.ok) return rotated;
    prop = await getProposal(d, id);
  }

  const ref = await rpc(d, 'texc_claim_reference', { p_proposal: id, p_prefix: BRAND.refPrefix });
  if (!ref.ok || typeof ref.json !== 'string') return { ok: false, status: 503, error: 'The reference could not be allocated. Try again.' };

  const firstIssue = !prop.passphrase_enc;
  let passphrase;
  try { passphrase = firstIssue ? newPassphrase() : open(prop.passphrase_enc); }
  catch { return { ok: false, status: 503, error: 'The proposal vault is not available. Nothing was published.' }; }
  const passphraseEnc = firstIssue ? seal(passphrase) : prop.passphrase_enc;
  const token = prop.access_token || linkToken();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revs = await rest(d, 'GET', `texc_proposal_revisions?proposal_id=eq.${id}&select=rev_index&order=rev_index.desc&limit=1`);
    if (!revs.ok) return { ok: false, status: 503, error: 'The proposal could not be read. Nothing was published.' };
    const index = (revs.json[0]?.rev_index || 0) + 1;
    const label = revLabel(index);
    const vt = viewToken();
    let built;
    try {
      built = toPublished(cfg, { tpl: templateData(), reference: ref.json, revLabel: label, issueDate: hobartToday(), viewToken: vt, templateVersion: TEMPLATE_VERSION, files: Object.fromEntries(fileRows.map((f) => [f.id, f])) });
    } catch (e) {
      if (e instanceof Unpublishable) return { ok: false, status: 422, error: e.message };
      throw e;
    }
    const text = JSON.stringify(built.config);
    try { assertClean(text); } catch (e) { return { ok: false, status: 422, error: e.message }; }
    const bytes = new TextEncoder().encode(text);
    const { enc: envelope, key } = await encryptRevision(bytes, passphrase);
    const linkExpires = linkExpiry(cfg.meta?.validUntil);
    const listing = listingFields(cfg);
    const res = await rpc(d, 'texc_publish', { p: {
      proposal_id: id, reference: ref.json, rev_index: index, rev_label: label,
      enc: envelope, enc_sha256: sha256(envelope), published_text: text, plaintext_sha256: sha256(bytes),
      view_token_hash: sha256(vt), template_version: TEMPLATE_VERSION, quote_snapshot: built.quoteSnapshot,
      terms_version: built.termsVersion, attachments_snapshot: built.attachmentsSnapshot, change_note: String(changeNote || '').slice(0, 500),
      published_by: who.email, access_token: token, passphrase_enc: passphraseEnc, link_expires_at: linkExpires,
      valid_until: cfg.meta?.validUntil || null, value_cents: built.quoteSnapshot.totals ? built.quoteSnapshot.totals.subtotal : null,
      ...listing,
      current_accepted: !!acceptedNow,
      key,
    } });
    if (res.status === 409 && /accepted meanwhile/.test(String(res.json && res.json.message))) {
      return { ok: false, status: 409, error: 'The client accepted the current revision while you were publishing. Open the checklist again: publishing over an acceptance needs acknowledging.' };
    }
    if (res.status === 409 && attempt === 0) continue; // someone published in between: rebuild once with the next letter
    if (!res.ok) return { ok: false, status: res.status === 409 ? 409 : 503, error: res.status === 409 ? 'Someone else published this proposal at the same moment. Refresh and try again.' : 'Publishing failed. Nothing was published.' };

    if (unlocked.length) await recordAudit(d, req, who, 'published_unlocked_safety', { proposalId: id, detail: { services: unlocked.map((s) => ({ slug: s.slug, by: s.safetyUnlockedBy })) } });
    const url = proposalUrl(prop.slug, token);
    let emailed = null;
    if (emailClient) emailed = await emailLink(d, who, id, cfg, url, label);
    return { ok: true, reference: ref.json, rev: label, url, firstIssue: firstIssue || !!rotated, passphrase: firstIssue || rotated ? passphrase : null, linkExpiresAt: linkExpires, emailed, reissued: !!rotated };
  }
  return { ok: false, status: 409, error: 'Someone else published this proposal at the same moment. Refresh and try again.' };
}

/** Email the client their link. The passphrase is NEVER in it: it goes by phone or text. */
export async function emailLink(d, who, id, cfg, url, label) {
  const to = String(cfg.client?.email || '').trim();
  if (!to) return { ok: false, reason: 'no client email' };
  const name = String(cfg.client?.contactName || '').split(/\s+/)[0] || 'there';
  const mail = layout({
    heading: `${BRAND.name} proposal: ${cfg.meta?.project || 'your project'}`,
    paras: [
      `Hi ${name},`,
      `${BRAND.principalName} has prepared a proposal for ${cfg.client?.company || 'you'}${label && label !== 'A' ? ` (revision ${label})` : ''}. It opens with a passphrase, which ${BRAND.name} will give you separately by phone or text message.`,
      'The link is private to you. Please do not forward it.',
    ],
    button: { label: 'Open the proposal', href: url },
    foot: `Questions: ${BRAND.principalName}, ${BRAND.phoneDisplay}, ${BRAND.email}`,
  });
  const sent = await sendEmail({ to, subject: `Proposal: ${cfg.meta?.project || BRAND.name}`, ...mail });
  await recordEvent(d, { proposalId: id, event: sent.ok ? 'link_emailed' : 'link_email_failed', actor: who.email, meta: { to } });
  return sent;
}

/** Admin: the passphrase, read back. Refused unless the read-back is audited first. */
export async function readPassphrase(d, req, who, id) {
  const prop = await getProposal(d, id);
  if (!prop || !prop.passphrase_enc) return { ok: false, status: 404, error: 'This proposal has not been published.' };
  const logged = await recordAudit(d, req, who, 'passphrase_read', { proposalId: id });
  if (!logged) return { ok: false, status: 503, error: 'The read-back could not be recorded, so it was not shown.' };
  try { return { ok: true, passphrase: open(prop.passphrase_enc) }; }
  catch { return { ok: false, status: 503, error: 'The proposal vault is not available.' }; }
}

/** Admin: a new link and passphrase. The old link stops working at once. */
export async function rotate(d, req, who, id) {
  const prop = await getProposal(d, id);
  if (!prop || !prop.passphrase_enc) return { ok: false, status: 404, error: 'This proposal has not been published.' };
  let oldPass;
  try { oldPass = open(prop.passphrase_enc); } catch { return { ok: false, status: 503, error: 'The proposal vault is not available.' }; }
  const revs = await rest(d, 'GET', `texc_proposal_revisions?proposal_id=eq.${id}&select=id`);
  const ids = revs.ok ? revs.json.map((r) => r.id) : [];
  const keyRows = ids.length ? await rest(d, 'GET', `texc_revision_keys?revision_id=in.(${ids.join(',')})&select=revision_id,kdf,iter,salt,iv,wrapped`) : { ok: true, json: [] };
  if (!revs.ok || !keyRows.ok || keyRows.json.length !== ids.length) return { ok: false, status: 503, error: 'The revisions could not be read. Nothing was changed.' };
  const newPass = newPassphrase();
  // Re-wrapped side by side: each is two PBKDF2 derivations, run on the thread pool.
  const keys = await Promise.all(keyRows.json.map(async (k) => ({ revision_id: k.revision_id, ...(await rewrap(k, oldPass, newPass)) })));
  const token = linkToken();
  const r = await rpc(d, 'texc_rotate', { p: { proposal_id: id, old_passphrase_enc: prop.passphrase_enc, passphrase_enc: seal(newPass), access_token: token, keys, actor: who.email } });
  if (!r.ok) return { ok: false, status: r.status === 409 ? 409 : 503, error: 'The link could not be rotated. Nothing was changed.' };
  await recordAudit(d, req, who, 'link_rotated', { proposalId: id });
  return { ok: true, url: proposalUrl(prop.slug, token), passphrase: newPass };
}

/**
 * Archive (with a reason) or restore. Archiving files a proposal away — its
 * client link refuses while it is archived, and nothing can be saved,
 * published or accepted on it — but withdraws nothing and deletes nothing.
 */
export async function setArchived(d, req, who, id, archive, reason) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (archive && why.length < 3) return { ok: false, status: 400, error: 'Say why it is being archived.' };
  const r = await rpc(d, 'texc_set_archived', { p: { proposal_id: id, archive: !!archive, actor: who.email, reason: why } });
  if (!r.ok) return { ok: false, status: r.status === 404 ? 404 : 503, error: r.status === 404 ? 'No such proposal.' : 'It could not be changed. Try again.' };
  if (r.json && r.json.changed) await recordAudit(d, req, who, archive ? 'archived' : 'restored', { proposalId: id, detail: archive ? { reason: why } : {} });
  return { ok: true, changed: !!(r.json && r.json.changed), archivedAt: (r.json && r.json.archived_at) || null };
}

/** Admin: mark a proposal as practice (left out of every figure and follow-up), or not. */
export async function setPractice(d, req, who, id, on) {
  const r = await rest(d, 'PATCH', `texc_proposals?id=eq.${id}&select=id`, { is_test: !!on });
  if (!r.ok || !Array.isArray(r.json) || !r.json.length) return { ok: false, status: r.ok ? 404 : 503, error: r.ok ? 'No such proposal.' : 'It could not be changed. Try again.' };
  await recordEvent(d, { proposalId: id, event: on ? 'marked_practice' : 'unmarked_practice', actor: who.email });
  await recordAudit(d, req, who, on ? 'marked_practice' : 'unmarked_practice', { proposalId: id });
  return { ok: true };
}

export async function withdraw(d, req, who, id, note) {
  const r = await rpc(d, 'texc_withdraw', { p_proposal: id, p_actor: who.email, p_note: String(note || '') });
  if (!r.ok) return { ok: false, status: r.status === 404 ? 404 : 503, error: r.status === 404 ? 'Nothing has been published to withdraw.' : 'It could not be withdrawn. Try again.' };
  await recordAudit(d, req, who, 'withdrawn', { proposalId: id, detail: { note: String(note || '').slice(0, 500) } });
  return { ok: true };
}

/** What the editor shows about a proposal: status, link, revisions. */
export async function summary(d, id, { withLink = true } = {}) {
  const prop = await getProposal(d, id);
  if (!prop) return null;
  const revs = await rest(d, 'GET', `texc_proposal_revisions?proposal_id=eq.${id}&select=id,rev_label,published_at,published_by,superseded_at,withdrawn_at,change_note&order=rev_index`);
  const labels = new Map((revs.ok ? revs.json : []).map((r) => [r.id, r.rev_label]));
  const accepted = await acceptancesOf(d, id);
  return {
    id: prop.id, slug: prop.slug, reference: prop.reference, status: prop.status, project: prop.project, client: prop.client_company,
    issuedAt: prop.issued_at, linkExpiresAt: prop.link_expires_at, firstOpenedAt: prop.first_opened_at, lastOpenedAt: prop.last_opened_at, openCount: prop.open_count,
    archivedAt: prop.archived_at || null, archivedBy: prop.archived_by || null, archiveReason: prop.archive_reason || null, practice: !!prop.is_test,
    url: withLink && prop.access_token ? proposalUrl(prop.slug, prop.access_token) : null,
    revisions: revs.ok ? revs.json.map((r) => ({ label: r.rev_label, publishedAt: r.published_at, publishedBy: r.published_by, superseded: !!r.superseded_at, withdrawn: !!r.withdrawn_at, note: r.change_note, current: r.id === prop.current_revision_id })) : [],
    acceptances: accepted.map((x) => ({ id: x.id, rev: labels.get(x.revision_id) || '', kind: x.kind, acceptedAt: x.accepted_at, name: x.name, position: x.position, company: x.company, totalCents: x.accepted_total_cents, recordedBy: x.recorded_by, current: x.revision_id === prop.current_revision_id })),
  };
}

/**
 * What the client would see differently if the draft were published now,
 * section by section, against the current revision. Built from the same
 * projection publishing uses, so it compares like with like.
 */
export async function changesSince(d, id) {
  const prop = await getProposal(d, id);
  const draft = prop && await getDraft(d, id);
  if (!prop || !draft || !prop.current_revision_id) return null;
  const rev = await one(d, `texc_proposal_revisions?id=eq.${prop.current_revision_id}&select=published_text,attachments_snapshot`);
  const fileRows = await listFiles(d, id);
  if (!rev || !fileRows) return null;
  let before;
  let after;
  let afterFiles;
  try {
    before = JSON.parse(rev.published_text);
    const built = toPublished(draft.config || {}, { tpl: templateData(), reference: before.meta.reference, revLabel: before.meta.rev, issueDate: before.meta.issueDate, viewToken: '', templateVersion: TEMPLATE_VERSION, files: Object.fromEntries(fileRows.map((f) => [f.id, f])) });
    after = built.config;
    afterFiles = built.attachmentsSnapshot;
  } catch {
    return [{ label: 'Draft', kind: 'has content that cannot be published yet (see the list above)' }];
  }
  const on = (cfg) => new Map(cfg.layout.sections.map((x, i) => [x.id, x.on ? i : -1]));
  const a = on(before);
  const b = on(after);
  const order = (m) => [...m].filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]).map(([k]) => k);
  const oa = order(a);
  const ob = order(b);
  const out = [];
  for (const s of SECTIONS) {
    const was = a.get(s.id) >= 0;
    const is = b.get(s.id) >= 0;
    if (was && !is) { out.push({ label: s.label, kind: 'now hidden' }); continue; }
    if (!was && is) { out.push({ label: s.label, kind: 'now shown' }); continue; }
    if (!is) continue;
    const pick = (cfg) => JSON.stringify(s.keys.map((k) => (k === 'meta' ? { ...cfg.meta, rev: 0, issueDate: 0, status: cfg.meta && cfg.meta.status } : cfg[k])));
    if (pick(before) !== pick(after)) out.push({ label: s.label, kind: 'changed' });
    else if (oa.indexOf(s.id) !== ob.indexOf(s.id) && oa.filter((x) => ob.includes(x)).indexOf(s.id) !== ob.filter((x) => oa.includes(x)).indexOf(s.id)) out.push({ label: s.label, kind: 'moved' });
  }
  if (JSON.stringify(before.tpl) !== JSON.stringify(after.tpl)) out.push({ label: 'Website wording', kind: 'updated since the last revision (it is frozen into each revision)' });
  if (JSON.stringify(before.media || {}) !== JSON.stringify(after.media || {})) out.push({ label: 'Photographs', kind: 'changed' });
  // A document's file can change while its card reads the same.
  const fileKey = (snap) => JSON.stringify((Array.isArray(snap) ? snap : []).map((x) => [x.card, x.sha256]));
  if (fileKey(rev.attachments_snapshot) !== fileKey(afterFiles) && !out.some((x) => x.label === 'Documents and attachments')) out.push({ label: 'Documents and attachments', kind: 'files changed' });
  return out;
}

export { enc };

/**
 * Acceptance (HP1), on the server — docs/architecture.md §6.
 *
 * A client accepts the CURRENT revision they decrypted, and nothing else:
 *   1. the link and the view token (the caller decrypted this revision)
 *   2. the SHA-256 of the exact bytes they decrypted equals the revision's —
 *      they accepted what was published, not a copy someone altered
 *   3. their details, both confirmations, and a signature the revision allows
 *   4. the total is recomputed here from the revision's own quote snapshot and
 *      the optional items they ticked; if it differs from the total the page
 *      showed them, nothing is accepted
 *   5. the signature and the acceptance record are stored, then texc_accept()
 *      writes the acceptance in one transaction with the proposal locked: of
 *      any number of simultaneous attempts exactly one wins, and the rest —
 *      like a second tap — get that acceptance back
 *   6. the office and the person accepting are emailed
 *
 * An administrator can record an acceptance received another way (a signed
 * PDF, an email): kind 'staff', with a note, audited.
 */
import { randomUUID, createHash } from 'node:crypto';
import { rest, rpc, one } from './db.js';
import { upload, remove, ACCEPT_BUCKET } from './storage.js';
import { BRAND } from './brand.js';
import { sendEmail, layout } from './notify-email.js';
import { recordEvent, recordAudit } from './events.js';
import { callerHash } from './ratelimit.js';
import { deviceFamily } from './http.js';
import { quoteTotals, formatAUD } from '../assets/js/money.js';
import { acceptClause, authorityClause, termsVersionOf, signatureMode, sameName, EMAIL_RE, LIMITS, nextHoldPoint } from '../assets/js/acceptance.js';
import { renderRecord, hobartTime } from './acceptance-record.js';
import { baseUrl } from './proposals.js';

export const PNG_MAX = 200_000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v) => String(v || '').split(/[;,\s]+/).filter(Boolean);
const COLUMNS = 'id,proposal_id,revision_id,kind,accepted_at,name,position,company,email,signature_kind,options,accepted_total_cents,totals,record_path,record_sha256,recorded_by,staff_note';

/** A PNG a browser canvas made, of a sane size: magic bytes, an IHDR, 1–4000 px each way. */
export function pngOk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.length > PNG_MAX) return false;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w > 0 && h > 0 && w <= 4000 && h <= 4000;
}

const revisionFacts = (d, id) => one(d, `texc_proposal_revisions?id=eq.${id}&select=id,rev_label,plaintext_sha256,enc_sha256,published_text,quote_snapshot,terms_version,superseded_at,withdrawn_at`);
export const acceptanceFor = (d, revisionId) => one(d, `texc_acceptances?revision_id=eq.${revisionId}&select=${COLUMNS}`);
export const acceptanceById = (d, id) => one(d, `texc_acceptances?id=eq.${id}&select=${COLUMNS}`);

/** What the client page is told about an acceptance. */
export function publicSummary(a, label) {
  return {
    id: a.id, rev: label, kind: a.kind, acceptedAt: a.accepted_at, name: a.name, position: a.position, company: a.company,
    options: Array.isArray(a.options) ? a.options : [], totalCents: a.accepted_total_cents, totalText: a.accepted_total_cents == null ? '' : formatAUD(a.accepted_total_cents),
  };
}

/** For the page after unlocking: is this revision accepted, can it be, and was an earlier one? */
export async function statusFor(d, found) {
  const mine = await acceptanceFor(d, found.rev.id);
  const isCurrent = found.rev.id === found.current.id;
  const out = { accepted: mine ? publicSummary(mine, found.rev.rev_label) : null, open: isCurrent && !mine, earlier: null };
  if (!mine && isCurrent) {
    const p = await one(d, `texc_proposals?id=eq.${found.prop.id}&select=accepted_at,accepted_revision_id`);
    if (p && p.accepted_revision_id && p.accepted_revision_id !== found.rev.id) {
      const r = await one(d, `texc_proposal_revisions?id=eq.${p.accepted_revision_id}&select=rev_label`);
      out.earlier = { rev: r ? r.rev_label : '', acceptedAt: p.accepted_at };
    }
  }
  return out;
}

function parsePublished(rev) {
  try { return JSON.parse(rev.published_text); } catch { return null; }
}

/** The sentences, quotation and framing of a revision, for the record. */
function recordBasics(cfg, rev) {
  const snap = rev.quote_snapshot || {};
  return {
    reference: cfg.meta && cfg.meta.reference, rev: rev.rev_label, project: cfg.meta && cfg.meta.project,
    site: [cfg.meta && cfg.meta.siteLocality, cfg.meta && cfg.meta.siteRegion].filter(Boolean).join(', '),
    clientCompany: (cfg.client && cfg.client.company) || '',
    clauses: { authority: authorityClause(cfg.client && cfg.client.company), accept: acceptClause(cfg.terms) },
    // The revision's own frozen copy of the locked line (lib/projection.js), word for word.
    hp1Framing: (cfg.tpl && cfg.tpl.locked && typeof cfg.tpl.locked.hp1Framing === 'string' && cfg.tpl.locked.hp1Framing) || '',
    termsVersion: termsVersionOf(cfg.terms), lines: Array.isArray(snap.lines) ? snap.lines : [],
  };
}

/** Store the files first (paths named by the acceptance id); on any later failure, take them back. */
async function storeFiles(base, html, png) {
  const stored = [];
  if (png) {
    const r = await upload(ACCEPT_BUCKET, `${base}-signature.png`, png, 'image/png');
    if (!r.ok) return null;
    stored.push(`${base}-signature.png`);
  }
  const r = await upload(ACCEPT_BUCKET, `${base}-record.html`, Buffer.from(html, 'utf8'), 'text/html');
  if (!r.ok) { if (stored.length) await remove(ACCEPT_BUCKET, stored); return null; }
  stored.push(`${base}-record.html`);
  return stored;
}

/**
 * A client's acceptance. `found` is client-access.resolve()'s answer for a
 * caller whose view token was checked. Returns { status, json }.
 */
export async function clientAccept(d, req, found, b) {
  const GONE = { status: 410, json: { error: 'gone' } };
  if (found.rev.id !== found.current.id) return GONE; // an earlier revision can be read, never accepted
  const rev = await revisionFacts(d, found.rev.id);
  if (!rev || rev.superseded_at || rev.withdrawn_at) return GONE;
  if (String(b.plaintextSha256 || '') !== rev.plaintext_sha256) return GONE;
  const had = await acceptanceFor(d, rev.id);
  if (had) return { status: 200, json: { already: true, acceptance: publicSummary(had, rev.rev_label) } };
  const cfg = parsePublished(rev);
  if (!cfg) return { status: 503, json: { error: 'unavailable' } };

  // The person and their confirmations.
  const f = { name: text(b.name, LIMITS.name), position: text(b.position, LIMITS.position), company: text(b.company, LIMITS.company), email: text(b.email, LIMITS.email) };
  const errors = [];
  if (f.name.length < 2) errors.push('name');
  if (!f.position) errors.push('position');
  if (!f.company) errors.push('company');
  if (!EMAIL_RE.test(f.email)) errors.push('email');
  if (b.authority !== true) errors.push('authority');
  if (b.accept !== true) errors.push('accept');

  // The signature the revision allows.
  const mode = signatureMode(cfg.accept);
  const typed = text(b.typed, LIMITS.name);
  let png = null;
  if (typeof b.drawn === 'string' && b.drawn) {
    png = /^[A-Za-z0-9+/=]+$/.test(b.drawn) && b.drawn.length < PNG_MAX * 1.4 ? Buffer.from(b.drawn, 'base64') : Buffer.alloc(0);
    if (!pngOk(png)) errors.push('drawn');
  }
  if (typed && !sameName(typed, f.name)) errors.push('typed');
  if (mode === 'typed' && !typed) errors.push('typed');
  if (mode === 'drawn' && !png) errors.push('drawn');
  if (mode === 'both' && !typed && !png) errors.push('signature');
  if (mode === 'typed' && png) errors.push('drawn');
  if (mode === 'drawn' && typed) errors.push('typed');

  // The quotation, recomputed from what was published.
  const snap = rev.quote_snapshot || {};
  const lines = Array.isArray(snap.lines) ? snap.lines : [];
  const optional = new Set(lines.filter((l) => l.optional).map((l) => l.id));
  const options = Array.isArray(b.options) ? [...new Set(b.options.map(String))] : [];
  if (options.length > 50 || options.some((o) => !optional.has(o))) errors.push('options');
  if (errors.length) return { status: 422, json: { error: 'incomplete', fields: [...new Set(errors)] } };
  let totals;
  try { totals = quoteTotals(lines, options); } catch { return { status: 503, json: { error: 'unavailable' } }; }
  if (Number(b.totalCents) !== totals.total) return { status: 409, json: { error: 'total', totalCents: totals.total, totalText: formatAUD(totals.total) } };

  const id = randomUUID();
  const acceptedAt = new Date().toISOString();
  const base = `proposals/${found.prop.id}/acceptances/${id}`;
  const ipHash = callerHash(req);
  const uaFamily = deviceFamily((req.headers || {})['user-agent']);
  const session = String(b.session || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64) || null;
  const signatureKind = png && typed ? 'drawn+typed' : png ? 'drawn' : 'typed';
  const basics = recordBasics(cfg, rev);
  const html = renderRecord({
    id, kind: 'client', acceptedAt, ...basics, signer: f, options, totals,
    signature: { kind: signatureKind, png: png ? png.toString('base64') : null, typed: typed || null },
    evidence: { plaintextSha256: rev.plaintext_sha256, encSha256: rev.enc_sha256, ipHash, uaFamily, session },
  });
  const stored = await storeFiles(base, html, png);
  if (!stored) return { status: 503, json: { error: 'unavailable' } };

  const r = await rpc(d, 'texc_accept', { p: {
    id, proposal_id: found.prop.id, revision_id: rev.id, kind: 'client', accepted_at: acceptedAt, ...f,
    authority_confirmed: true, terms_confirmed: true, terms_version: basics.termsVersion, clauses: basics.clauses,
    signature_kind: signatureKind, signature_path: png ? `${base}-signature.png` : null, signature_sha256: png ? sha(png) : null,
    typed_signature: typed || null, options, accepted_total_cents: totals.total, totals,
    plaintext_sha256: rev.plaintext_sha256, ip_hash: ipHash, ua_family: uaFamily, session,
    record_path: `${base}-record.html`, record_sha256: sha(Buffer.from(html, 'utf8')),
  } });
  if (!r.ok || !r.json) {
    await remove(ACCEPT_BUCKET, stored);
    return r.status === 409 ? GONE : { status: 503, json: { error: 'unavailable' } };
  }
  if (r.json.won !== true) {
    await remove(ACCEPT_BUCKET, stored);
    const winner = await acceptanceFor(d, rev.id);
    return { status: 200, json: { already: true, acceptance: winner ? publicSummary(winner, rev.rev_label) : null } };
  }
  const mine = await acceptanceFor(d, rev.id);
  await notifyAccepted(d, { id, acceptedAt, ...basics, signer: f, totals, options, lines, cfg, propId: found.prop.id, revId: rev.id });
  return { status: 200, json: { accepted: true, acceptance: mine ? publicSummary(mine, rev.rev_label) : null } };
}

async function notifyAccepted(d, a) {
  const chosen = a.lines.filter((l) => l.optional && a.options.includes(l.id)).map((l) => l.desc);
  const total = `Total inc GST: ${formatAUD(a.totals.total)}${a.totals.unpriced ? `, plus ${a.totals.unpriced === 1 ? 'one item' : `${a.totals.unpriced} items`} at cost` : ''}.`;
  const opts = chosen.length ? `Optional items chosen: ${chosen.join('; ')}.` : 'No optional items chosen.';
  const when = hobartTime(a.acceptedAt);
  const office = layout({
    heading: 'A proposal has been accepted',
    paras: [
      `${a.signer.name} (${a.signer.position}, ${a.signer.company}) accepted ${a.reference}, revision ${a.rev}${a.project ? ` — ${a.project}` : ''}, on ${when}.`,
      total, opts, a.hp1Framing,
    ].filter(Boolean),
    button: { label: 'Open the acceptance record', href: `${baseUrl()}/staff/acceptance/${a.id}` },
    foot: `Reply to ${a.signer.email} to reach them.`,
  });
  const subject = `Accepted: ${a.reference} — ${a.signer.company}`;
  if (process.env.NOTIFY_TO) await sendEmail({ to: list(process.env.NOTIFY_TO), subject, ...office });
  if (process.env.NOTIFY_BCC) await sendEmail({ to: list(process.env.NOTIFY_BCC), subject, ...office });
  const hp2 = nextHoldPoint(a.cfg);
  const first = a.signer.name.split(/\s+/)[0];
  const mail = layout({
    heading: 'Your acceptance is recorded',
    paras: [
      `Hi ${first},`,
      `${BRAND.name} has your acceptance of proposal ${a.reference}, revision ${a.rev}${a.project ? ` (${a.project})` : ''}, given on ${when} on behalf of ${a.signer.company}.`,
      total, opts, a.hp1Framing,
      hp2 ? `Next: ${hp2.code} — ${hp2.title}.${hp2.requirement ? ` ${hp2.requirement}` : ''}` : '',
      `${BRAND.principalName} will be in touch about the next step.`,
    ].filter(Boolean),
    foot: `Questions: ${BRAND.principalName}, ${BRAND.phoneDisplay}, ${BRAND.email}`,
  });
  const sent = await sendEmail({ to: a.signer.email, subject: `Your acceptance: ${a.reference}`, ...mail });
  // The acceptance stands whether or not the email goes; a failure is logged for the office to follow up.
  if (!sent.ok) await recordEvent(d, { proposalId: a.propId, revisionId: a.revId, event: 'acceptance_email_failed', meta: { to: a.signer.email } });
}

/**
 * An administrator records an acceptance received another way. The proposal's
 * current revision, its default optional items, a mandatory note. Audited.
 */
export async function staffAccept(d, req, who, proposalId, b) {
  const prop = await one(d, `texc_proposals?id=eq.${proposalId}&select=id,status,current_revision_id,archived_at`);
  if (prop && prop.archived_at) return { status: 409, json: { error: 'This proposal is archived. Restore it first.' } };
  if (!prop || prop.status !== 'issued' || !prop.current_revision_id) return { status: 409, json: { error: 'Only an issued proposal can be accepted.' } };
  const rev = await revisionFacts(d, prop.current_revision_id);
  if (!rev) return { status: 503, json: { error: 'The proposal could not be read.' } };
  if (await acceptanceFor(d, rev.id)) return { status: 409, json: { error: `Revision ${rev.rev_label} is already accepted.` } };
  const cfg = parsePublished(rev);
  if (!cfg) return { status: 503, json: { error: 'The proposal could not be read.' } };
  const f = { name: text(b.name, LIMITS.name), position: text(b.position, LIMITS.position), company: text(b.company, LIMITS.company) || text(cfg.client && cfg.client.company, LIMITS.company), email: text(b.email, LIMITS.email) };
  const note = text(b.note, 500);
  if (f.name.length < 2) return { status: 400, json: { error: 'Who accepted it? Their full name.' } };
  if (f.email && !EMAIL_RE.test(f.email)) return { status: 400, json: { error: 'That email address is not valid.' } };
  if (note.length < 10) return { status: 400, json: { error: 'Say how the acceptance was received, in a sentence (it is kept with the record).' } };
  const snap = rev.quote_snapshot || {};
  const lines = Array.isArray(snap.lines) ? snap.lines : [];
  const options = Array.isArray(snap.defaultOptions) ? snap.defaultOptions : [];
  let totals;
  try { totals = quoteTotals(lines, options); } catch { return { status: 503, json: { error: 'The quotation could not be read.' } }; }
  const id = randomUUID();
  const acceptedAt = new Date().toISOString();
  const basics = recordBasics(cfg, rev);
  const html = renderRecord({
    id, kind: 'staff', acceptedAt, ...basics, signer: f, options, totals, signature: { kind: 'none' },
    evidence: { encSha256: rev.enc_sha256 }, staff: { recordedBy: who.email, note },
  });
  const logged = await recordAudit(d, req, who, 'acceptance_recorded', { proposalId, target: id, detail: { rev: rev.rev_label, name: f.name, note } });
  if (!logged) return { status: 503, json: { error: 'The acceptance could not be recorded. Nothing was changed.' } };
  const base = `proposals/${proposalId}/acceptances/${id}`;
  const stored = await storeFiles(base, html, null);
  if (!stored) return { status: 503, json: { error: 'The record could not be stored. Nothing was changed.' } };
  const r = await rpc(d, 'texc_accept', { p: {
    id, proposal_id: proposalId, revision_id: rev.id, kind: 'staff', accepted_at: acceptedAt, ...f,
    terms_version: basics.termsVersion, clauses: basics.clauses, signature_kind: 'none', options, accepted_total_cents: totals.total, totals,
    recorded_by: who.email, staff_note: note, record_path: `${base}-record.html`, record_sha256: sha(Buffer.from(html, 'utf8')),
  } });
  if (!r.ok || !r.json || r.json.won !== true) {
    await remove(ACCEPT_BUCKET, stored);
    return { status: 409, json: { error: r.ok ? `Revision ${rev.rev_label} was accepted in the meantime.` : 'This revision is not open for acceptance.' } };
  }
  return { status: 200, json: { id, rev: rev.rev_label, acceptedAt } };
}

/** Every acceptance of a proposal, for staff. */
export async function acceptancesOf(d, proposalId) {
  const r = await rest(d, 'GET', `texc_acceptances?proposal_id=eq.${proposalId}&select=id,revision_id,kind,accepted_at,name,position,company,accepted_total_cents,recorded_by&order=accepted_at`);
  return r.ok && Array.isArray(r.json) ? r.json : [];
}

/** The client asks for changes. Logged and sent to the office; nothing is claimed. */
export async function requestChanges(d, req, found, b) {
  const f = { name: text(b.name, LIMITS.name), email: text(b.email, LIMITS.email) };
  const message = typeof b.message === 'string' ? b.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, LIMITS.message) : '';
  const errors = [];
  if (f.name.length < 2) errors.push('name');
  if (!EMAIL_RE.test(f.email)) errors.push('email');
  if (message.length < 5) errors.push('message');
  if (errors.length) return { status: 422, json: { error: 'incomplete', fields: errors } };
  const p = found.prop;
  const ok = await recordEvent(d, {
    proposalId: p.id, revisionId: found.rev.id, event: 'changes_requested',
    session: String(b.session || '').replace(/[^a-z0-9-]/gi, '').slice(0, 64) || null,
    meta: { name: f.name, email: f.email, message, rev: found.rev.rev_label },
  });
  if (!ok) return { status: 503, json: { error: 'unavailable' } };
  if (process.env.NOTIFY_TO) {
    const mail = layout({
      heading: 'Changes requested on a proposal',
      paras: [`${f.name} (${f.email}) asked for changes to ${p.reference || 'a proposal'}, revision ${found.rev.rev_label}${p.project ? ` — ${p.project}` : ''}:`, ...message.split(/\n+/)],
      button: { label: 'Open the editor', href: `${baseUrl()}/editor/${p.id}` },
      foot: `Reply to ${f.email} to reach them.`,
    });
    await sendEmail({ to: list(process.env.NOTIFY_TO), subject: `Changes requested: ${p.reference || BRAND.name + ' proposal'}`, ...mail });
  }
  return { status: 200, json: { sent: true } };
}

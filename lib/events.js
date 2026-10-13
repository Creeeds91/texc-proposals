/**
 * The two logs.
 *
 *   texc_events        what happened to a proposal (published, opened, an option
 *                      ticked, printed, the link rotated…). Append-only.
 *   texc_staff_audit   who on the staff side did something sensitive (read a
 *                      passphrase back, rotated a link, overwrote a colleague's
 *                      draft, unlocked a compliance line). Append-only.
 *
 * Recording is best-effort and never throws: a log write must not break the
 * page a client is reading. The audit is the exception callers can check —
 * recordAudit answers true/false — because for a passphrase read-back the
 * record IS the control.
 */
import { rest } from './db.js';
import { callerHash } from './ratelimit.js';

/** What a client page may report. Anything else is dropped. */
export const CLIENT_EVENTS = Object.freeze(['option_toggled', 'printed', 'pdf_downloaded']);

export async function recordEvent(d, { proposalId, revisionId = null, event, session = null, actor = null, meta = {} }) {
  if (!d || !proposalId || !event) return false;
  const r = await rest(d, 'POST', 'texc_events', {
    proposal_id: proposalId, revision_id: revisionId, event: String(event).slice(0, 40),
    session: session ? String(session).slice(0, 64) : null, actor: actor ? String(actor).slice(0, 160) : null,
    meta: meta && typeof meta === 'object' ? meta : {},
  }, { prefer: 'return=minimal' });
  return r.ok;
}

export async function recordAudit(d, req, who, action, { proposalId = null, target = null, detail = {} } = {}) {
  if (!d) return false;
  const r = await rest(d, 'POST', 'texc_staff_audit', {
    actor: who && who.email ? who.email : 'unknown', role: who && who.role ? who.role : '',
    action: String(action).slice(0, 60), proposal_id: proposalId, target: target ? String(target).slice(0, 200) : null,
    detail: detail && typeof detail === 'object' ? detail : {}, ip_hash: callerHash(req),
  }, { prefer: 'return=minimal' });
  return r.ok;
}

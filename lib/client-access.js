/**
 * Who may see a revision, for the client endpoints. Every "no" is the same no:
 * the caller gets the uniform 410 whether the slug never existed, the token is
 * wrong, the link has expired, the proposal was withdrawn or archived, or the
 * revision was withdrawn.
 *
 *   resolve(d, { slug, t, rev })   → { prop, rev, revisions } | null
 *   viewTokenOk(rev, vt)           → the caller decrypted this revision
 */
import { rest, one } from './db.js';
import { same, sha256, SLUG_RE, HEX64_RE } from './tokens.js';

const LABEL_RE = /^[A-Z]{1,3}$/;

export function shapes({ slug, t, rev }) {
  return SLUG_RE.test(String(slug || '')) && HEX64_RE.test(String(t || '')) && (rev === undefined || rev === null || rev === '' || LABEL_RE.test(String(rev)));
}

export async function resolve(d, { slug, t, rev }) {
  if (!d || !shapes({ slug, t, rev })) return null;
  const prop = await one(d, `texc_proposals?slug=eq.${slug}&select=id,slug,access_token,link_expires_at,status,current_revision_id,client_company,project,reference,archived_at`);
  if (!prop || !same(prop.access_token, t)) return null;
  if (prop.archived_at) return null;
  if (prop.status !== 'issued' || !prop.current_revision_id) return null;
  if (prop.link_expires_at && new Date(prop.link_expires_at) <= new Date()) return null;
  const r = await rest(d, 'GET', `texc_proposal_revisions?proposal_id=eq.${prop.id}&withdrawn_at=is.null&select=id,rev_label,rev_index,view_token_hash,superseded_at&order=rev_index`);
  if (!r.ok || !Array.isArray(r.json) || !r.json.length) return null;
  const current = r.json.find((x) => x.id === prop.current_revision_id);
  if (!current) return null;
  const chosen = rev ? r.json.find((x) => x.rev_label === rev) : current;
  if (!chosen) return null;
  return { prop, rev: chosen, current, revisions: r.json.map((x) => x.rev_label) };
}

export const viewTokenOk = (revision, vt) => HEX64_RE.test(String(vt || '')) && same(sha256(String(vt)), revision.view_token_hash);

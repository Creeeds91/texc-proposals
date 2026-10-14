/**
 * GET /staff/revision/<id> — any published revision, as it was sent, for
 * staff of any role (Phase 9). The page is the client page itself
 * (lib/revision-html.js, built from templates/proposal.html) booted by
 * assets/js/archive-view.js, which asks /api/archive for the revision's own
 * published text: nothing from today's draft or library. Nothing it does is
 * recorded as the client's: no open, no event, and acceptance is shown, never
 * offered.
 *
 * It may be framed by this origin only (REVISION_CSP): the Archive page
 * frames it to make the record pack's readable copy.
 */
import { REVISION_HTML } from '../lib/revision-html.js';
import { REVISION_CSP } from '../lib/csp.js';
import { db } from '../lib/db.js';
import { requireRole } from '../lib/accounts.js';
import { onlyMethods } from '../lib/http.js';
import { UUID_RE } from '../lib/tokens.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (onlyMethods(req, res, ['GET'])) return;
  const id = String((req.query || {}).id || '');
  const who = await requireRole(req, res, db(), 'viewer', { page: true, next: UUID_RE.test(id) ? `/staff/revision/${id}` : '/archive' });
  if (!who) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', REVISION_CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(REVISION_HTML);
}

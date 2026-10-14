/**
 * GET /archive — the archive, for staff of any role (Phase 9): every revision
 * ever sent, found by proposal or document; each opened as it was sent; the
 * record pack; the keeping periods.
 *
 * Like the dashboard, a generated string (lib/archive-html.js) rather than a
 * public file; its data comes from /api/archive. Its policy (ARCHIVE_CSP) is
 * the client page's plus one thing: it may frame a revision from this origin,
 * which is how the record pack makes each revision's readable copy.
 */
import { ARCHIVE_HTML } from '../lib/archive-html.js';
import { ARCHIVE_CSP } from '../lib/csp.js';
import { db } from '../lib/db.js';
import { requireRole } from '../lib/accounts.js';
import { onlyMethods } from '../lib/http.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (onlyMethods(req, res, ['GET'])) return;
  const who = await requireRole(req, res, db(), 'viewer', { page: true, next: '/archive' });
  if (!who) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', ARCHIVE_CSP);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(ARCHIVE_HTML);
}

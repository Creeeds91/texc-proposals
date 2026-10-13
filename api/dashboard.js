/**
 * GET /dashboard — the archive and reporting page, for staff of any role.
 *
 * Like the editor, a generated string (lib/dashboard-html.js) rather than a
 * public file; its data comes from /api/analytics. No session, and the browser
 * is sent to sign in and brought back.
 */
import { DASHBOARD_HTML } from '../lib/dashboard-html.js';
import { CLIENT_CSP } from '../lib/csp.js';
import { db } from '../lib/db.js';
import { requireRole } from '../lib/accounts.js';
import { onlyMethods } from '../lib/http.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (onlyMethods(req, res, ['GET'])) return;
  const who = await requireRole(req, res, db(), 'viewer', { page: true, next: '/dashboard' });
  if (!who) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', CLIENT_CSP);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(DASHBOARD_HTML);
}

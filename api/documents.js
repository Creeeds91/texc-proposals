/**
 * GET /documents — the document library, for staff of any role (Phase 8).
 *
 * Like the dashboard, a generated string (lib/library-html.js) rather than a
 * public file; its data comes from /api/library. No session, and the browser
 * is sent to sign in and brought back.
 */
import { LIBRARY_HTML } from '../lib/library-html.js';
import { CLIENT_CSP } from '../lib/csp.js';
import { db } from '../lib/db.js';
import { requireRole } from '../lib/accounts.js';
import { onlyMethods } from '../lib/http.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (onlyMethods(req, res, ['GET'])) return;
  const who = await requireRole(req, res, db(), 'viewer', { page: true, next: '/documents' });
  if (!who) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', CLIENT_CSP);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(LIBRARY_HTML);
}

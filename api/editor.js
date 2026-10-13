/**
 * GET /editor, /editor/<id>  — the editor page, for editors and above.
 * GET /api/editor?fixture=demo — the demo proposal, for "Load the demo".
 *
 * The page is a generated string (lib/editor-html.js), never a public file:
 * it carries the editor library. No session, and the browser is sent to sign in.
 */
import { EDITOR_HTML } from '../lib/editor-html.js';
import { EDITOR_CSP } from '../lib/csp.js';
import { DEMO_FIXTURE } from '../lib/demo-fixture.js';
import { db } from '../lib/db.js';
import { requireRole } from '../lib/accounts.js';
import { onlyMethods } from '../lib/http.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (onlyMethods(req, res, ['GET'])) return;
  const d = db();
  const fixture = (req.query || {}).fixture === 'demo';
  const id = String((req.query || {}).id || '');
  const next = /^[0-9a-f-]{36}$/.test(id) ? `/editor/${id}` : '/editor';
  const who = await requireRole(req, res, d, 'editor', { page: !fixture, next });
  if (!who) return;
  res.setHeader('Cache-Control', 'no-store');
  if (fixture) { res.status(200).json(DEMO_FIXTURE); return; }
  res.setHeader('Content-Security-Policy', EDITOR_CSP);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(EDITOR_HTML);
}

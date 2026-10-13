/**
 * GET /staff/acceptance/<id>  — an acceptance record, exactly as stored at the
 * moment of acceptance. Staff only (any role). The bytes are checked against
 * the fingerprint written with the acceptance; a record that does not match is
 * not shown as if it did.
 */
import { db } from '../lib/db.js';
import { onlyMethods } from '../lib/http.js';
import { requireRole } from '../lib/accounts.js';
import { acceptanceById } from '../lib/acceptances.js';
import { download, ACCEPT_BUCKET } from '../lib/storage.js';
import { RECORD_CSP } from '../lib/acceptance-record.js';
import { sha256, UUID_RE } from '../lib/tokens.js';

export const config = { maxDuration: 10 };

function plain(res, status, text) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(status).send(text);
}

export default async function handler(req, res) {
  if (onlyMethods(req, res, ['GET'])) return;
  const d = db();
  const id = String((req.query || {}).id || '');
  const who = await requireRole(req, res, d, 'viewer', { page: true, next: UUID_RE.test(id) ? `/staff/acceptance/${id}` : '/dashboard' });
  if (!who) return;
  if (!UUID_RE.test(id)) { plain(res, 404, 'No such acceptance record.'); return; }
  const row = await acceptanceById(d, id);
  if (!row) { plain(res, 404, 'No such acceptance record.'); return; }
  const got = await download(ACCEPT_BUCKET, row.record_path, 2_000_000);
  if (!got.ok) { plain(res, 503, 'The record could not be read. Try again.'); return; }
  if (sha256(got.bytes) !== row.record_sha256) {
    plain(res, 409, 'This stored record does not match the fingerprint written when it was accepted, so it is not shown. Tell Brand in Black.');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', RECORD_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(got.bytes);
}

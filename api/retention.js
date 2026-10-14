/**
 * GET /api/retention — the daily retention run (vercel.json "crons";
 * lib/retention.js says what it does). Vercel calls it with
 * Authorization: Bearer <CRON_SECRET>; anything else is refused, and without
 * CRON_SECRET set it never runs. It only ever archives, as "retention", and
 * the staff audit records what it archived.
 */
import { timingSafeEqual } from 'node:crypto';
import { db } from '../lib/db.js';
import { onlyMethods, noStore } from '../lib/http.js';
import { recordAudit } from '../lib/events.js';
import { runRetention } from '../lib/retention.js';

export const config = { maxDuration: 60 };

const RUNNER = Object.freeze({ email: 'retention', role: 'system' });

function authorised(req) {
  const secret = process.env.CRON_SECRET || '';
  const given = String((req.headers || {}).authorization || '');
  const want = `Bearer ${secret}`;
  return secret.length >= 16 && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['GET'])) return;
  if (!authorised(req)) { res.status(401).json({ error: 'Not allowed.' }); return; }
  const d = db();
  const out = d ? await runRetention(d) : null;
  if (!out) { res.status(503).json({ error: 'The retention run could not complete.' }); return; }
  if (out.archived.length) await recordAudit(d, req, RUNNER, 'proposals_archived_automatically', { detail: { days: out.days, proposals: out.archived } });
  res.status(200).json({ archived: out.archived.length, days: out.days });
}

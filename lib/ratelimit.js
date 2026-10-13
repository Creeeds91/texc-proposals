/**
 * Rate limits, counted in Postgres (texc_rate_hit) so every serverless instance
 * sees the same number. Ported from the Roberts repo (lib/iap-ratelimit.js).
 *
 * Callers are identified by a truncated KEYED hash of the first
 * x-forwarded-for address: without IP_HASH_KEY, which lives only in the
 * deployment, a copy of the tables cannot be turned back into addresses.
 *
 * Two failure modes, on purpose:
 *   rateLimited()   fails OPEN — it blunts enumeration and mail-bombing; a
 *                   database hiccup must not lock a client out of their proposal.
 *   limitStrict()   fails CLOSED — for guessing a sign-in code, where the
 *                   ceiling IS the security property.
 */
import { createHash, createHmac } from 'node:crypto';
import { rpc } from './db.js';

function hashKey() {
  const own = process.env.IP_HASH_KEY || '';
  if (own) return own;
  // Domain-separated derivation from the database key, so a deployment without
  // its own key still never writes a reversible hash.
  return createHash('sha256').update('texc-caller-hash\0' + (process.env.SUPABASE_SECRET_KEY || '')).digest();
}

export function keyedHash(value, hexChars = 16) {
  return createHmac('sha256', hashKey()).update(String(value)).digest('hex').slice(0, hexChars);
}

export function callerHash(req) {
  const ip = String(((req && req.headers) || {})['x-forwarded-for'] || '').split(',')[0].trim();
  return ip ? keyedHash(ip) : 'unknown';
}

async function hit(d, key, max, windowSeconds) {
  const r = await rpc(d, 'texc_rate_hit', { p_key: String(key).slice(0, 160), p_max: max, p_window_seconds: windowSeconds });
  if (!r.ok || typeof r.json !== 'boolean') return null;
  return r.json;
}

/** true = over the limit. Fails open. */
export async function rateLimited(d, req, route, max, windowSeconds = 60) {
  if (!d) return false;
  const allowed = await hit(d, `${route}:${callerHash(req)}`, max, windowSeconds);
  return allowed === false;
}

/** true = over the limit OR the count could not be taken. Fails closed. */
export async function limitStrict(d, key, max, windowSeconds = 60) {
  if (!d || !key) return true;
  const allowed = await hit(d, key, max, windowSeconds);
  return allowed !== true;
}

export function tooMany(res) {
  res.setHeader('Retry-After', '60');
  res.setHeader('Cache-Control', 'no-store');
  res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
}

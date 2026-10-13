/** Random identifiers, hashes and constant-time comparison. */
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';

export const randomHex = (bytes) => randomBytes(bytes).toString('hex');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** A proposal link token: 32 bytes, 64 hex. */
export const linkToken = () => randomHex(32);
/** A view token sealed inside the encrypted proposal: proves the holder decrypted it. */
export const viewToken = () => randomHex(32);

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
/** The 10-character path id in /p/<slug>. randomInt is uniform (no modulo bias). */
export function slug() {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return out;
}

export const SLUG_RE = /^[a-z0-9]{10}$/;
export const HEX64_RE = /^[a-f0-9]{64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Constant-time string equality; false for empty or different lengths. */
export function same(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/**
 * How a published revision is encrypted. WebCrypto on both sides — this file
 * on the server at publish, assets/js/gate.js in the client's browser — so the
 * two cannot drift; `node scripts/check.mjs envelope` encrypts here and
 * decrypts in Chromium.
 *
 * Two layers, so a passphrase can be rotated without touching what was
 * published:
 *
 *   content   AES-256-GCM under a random 256-bit content key, one per revision.
 *             Stored in texc_proposal_revisions.enc and NEVER changed again:
 *             { v: 1, alg: 'A256GCM', iv, ct }
 *   key wrap  the content key, AES-256-GCM-encrypted under a key derived from
 *             the proposal passphrase with PBKDF2-SHA256 (600,000 iterations,
 *             fresh 16-byte salt). Stored in texc_revision_keys:
 *             { kdf: 'PBKDF2-SHA256', iter, salt, iv, wrapped }
 *             Rotating the passphrase re-wraps this and nothing else.
 *
 * All binary values are base64.
 */
const subtle = globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

export const KDF = 'PBKDF2-SHA256';
export const ITERATIONS = 600_000;

async function kek(passphrase, salt, iter) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Wrap raw content-key bytes under a passphrase. */
export async function wrapKey(rawKey, passphrase, iter = ITERATIONS) {
  const salt = rand(16);
  const iv = rand(12);
  const k = await kek(passphrase, salt, iter);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, k, rawKey));
  return { kdf: KDF, iter, salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped) };
}

/** Unwrap a key record with a passphrase. Throws on a wrong passphrase. */
export async function unwrapKey(record, passphrase) {
  if (record.kdf !== KDF) throw new Error('unknown kdf');
  const k = await kek(passphrase, unb64(record.salt), Number(record.iter));
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, k, unb64(record.wrapped)));
}

/**
 * Encrypt the published bytes. Returns { enc: <JSON string>, key: <wrap record> }.
 */
export async function encryptRevision(plaintextBytes, passphrase) {
  const rawKey = rand(32);
  const iv = rand(12);
  const ck = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, ck, plaintextBytes));
  const key = await wrapKey(rawKey, passphrase);
  rawKey.fill(0);
  return { enc: JSON.stringify({ v: 1, alg: 'A256GCM', iv: b64(iv), ct: b64(ct) }), key };
}

/** Decrypt (server side: tests, and re-checks). Returns the plaintext bytes. */
export async function decryptRevision(encText, keyRecord, passphrase) {
  const env = JSON.parse(encText);
  if (env.v !== 1 || env.alg !== 'A256GCM') throw new Error('unknown envelope');
  const rawKey = await unwrapKey(keyRecord, passphrase);
  const ck = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, ck, unb64(env.ct)));
}

/** Re-wrap a revision's key under a new passphrase (rotation). */
export async function rewrap(record, oldPassphrase, newPassphrase) {
  const raw = await unwrapKey(record, oldPassphrase);
  const out = await wrapKey(raw, newPassphrase, ITERATIONS);
  raw.fill(0);
  return out;
}

/**
 * Opening a published revision in the browser: the other half of
 * lib/envelope.js. Used by the gate; `node scripts/check.mjs envelope`
 * encrypts on the server side and opens with this exact module in Chromium.
 *
 *   openEnvelope({ enc, key }, passphrase) -> { bytes, sha }   (sha: hex SHA-256 of the plaintext bytes)
 *   A wrong passphrase throws an Error with .passphrase = true.
 */
const subtle = globalThis.crypto && globalThis.crypto.subtle;
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const supported = () => !!subtle;

export async function openEnvelope(data, passphrase) {
  if (!data || !data.key || data.key.kdf !== 'PBKDF2-SHA256') throw new Error('format');
  const base = await subtle.importKey('raw', new TextEncoder().encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const kek = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(data.key.salt), iterations: Number(data.key.iter) }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let raw;
  try { raw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(data.key.iv) }, kek, unb64(data.key.wrapped)); }
  catch { const e = new Error('passphrase'); e.passphrase = true; throw e; }
  const env = JSON.parse(data.enc);
  if (env.v !== 1 || env.alg !== 'A256GCM') throw new Error('format');
  const ck = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, ck, unb64(env.ct));
  return { bytes, sha: hex(await subtle.digest('SHA-256', bytes)) };
}

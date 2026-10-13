/**
 * Secrets the database must hold but must not be able to read on its own —
 * today, each proposal's passphrase. Sealed with AES-256-GCM under VAULT_KEY,
 * which lives only in the deployment's environment, never in the database: a
 * copy of the tables (or a backup) does not reveal any passphrase.
 *
 * It does NOT make the proposal itself secret from the database: drafts and
 * each revision's published text are stored server-side in plaintext (as in
 * the Roberts system), so staff tools, change lists and acceptance can read
 * them. docs/data-handling.md says what is held where.
 *
 *   VAULT_KEY   32 random bytes, base64. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
 *
 * Fails closed: no key, or a wrong one, throws. Format: v1.<iv b64url>.<ct+tag b64url>
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key() {
  const raw = Buffer.from(String(process.env.VAULT_KEY || ''), 'base64');
  if (raw.length !== 32) throw new Error('VAULT_KEY is not set to 32 bytes of base64');
  return raw;
}

export function vaultReady() {
  try { key(); return true; } catch { return false; }
}

export function seal(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}`;
}

export function open(sealed) {
  const [v, ivB, ctB] = String(sealed || '').split('.');
  if (v !== 'v1' || !ivB || !ctB) throw new Error('not a sealed value');
  const all = Buffer.from(ctB, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
}

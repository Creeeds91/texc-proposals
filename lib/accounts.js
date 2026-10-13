/**
 * Staff accounts: who someone is, and whether they may still be here.
 * Ported in principle from the Roberts repo (lib/iap-accounts.js, api/auth.js),
 * without its legacy shared-password door — this is a new system.
 *
 *   sign in    type your work address → a six-digit code by email, 15 minutes,
 *              single use, typed back into the page that asked. Nothing
 *              bearer-like travels in a URL, so a mail scanner cannot spend it.
 *   session    an httpOnly, Secure, host-only cookie holding 32 random bytes,
 *              30 days, revocable. The database keeps sha256(token) only.
 *   roles      viewer  < editor < admin < super
 *              viewer  reads (the archive, Phase 6)
 *              editor  builds and publishes proposals
 *              admin   also rotates links, reads passphrases back, unlocks
 *                      compliance lines, approves people
 *              super   Brand in Black. NEVER STORED: computed from ACCOUNT_SUPERS
 *                      on every request, so no route, and no leaked database
 *                      key, can mint one. A super can sign in before any row
 *                      exists, which is how the first admin is approved.
 *
 * Two rules this file does not bend:
 *   1. The sign-in box answers identically for every address. Whether someone
 *      has an account is not something a stranger learns by typing it in;
 *      only what gets EMAILED differs, and only its owner sees that.
 *   2. Auth fails closed. A database error is "no".
 *
 * Role and status are read on every request: suspend someone and it takes hold
 * on their next click.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { rest, one, enc } from './db.js';
import { parseCookies, deviceFamily } from './http.js';
import { BRAND } from './brand.js';

export const SESSION_COOKIE = '__Host-texc_sess';
const CODE_MINUTES = 15;
const SESSION_DAYS = 30;
export const RANK = Object.freeze({ viewer: 1, editor: 2, admin: 3, super: 4 });

const nowIso = () => new Date().toISOString();
const inMs = (ms) => new Date(Date.now() + ms).toISOString();
export const hashToken = (t) => createHash('sha256').update(String(t), 'utf8').digest('hex');

const EMAIL_RE = /^[a-z0-9][a-z0-9._%+-]{0,62}@[a-z0-9][a-z0-9.-]{0,61}\.[a-z]{2,}$/;
export function normEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 160 ? e : '';
}

const list = (raw) => String(raw || '').split(/[;,\s]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
export const superEmails = () => new Set(list(process.env.ACCOUNT_SUPERS).filter((e) => e.includes('@')));
export const isSuper = (email) => !!email && superEmails().has(String(email).toLowerCase());
export function allowedDomains() {
  const own = list(process.env.ACCOUNT_DOMAINS);
  return own.length ? own : [BRAND.web];
}
export const domainAllowed = (email) => allowedDomains().includes(email.slice(email.lastIndexOf('@') + 1));

export function effectiveRole(user) {
  if (!user || !user.email) return 'viewer';
  if (isSuper(user.email)) return 'super';
  return ['admin', 'editor', 'viewer'].includes(user.role) ? user.role : 'viewer';
}
export const atLeast = (role, min) => (RANK[role] || 0) >= (RANK[min] || 99);

export async function findUser(d, email) {
  if (!d || !email) return null;
  return one(d, `texc_users?email=eq.${enc(email)}&select=email,name,role,status,created_at,approved_at,last_seen_at`);
}

/* ------------------------------------------------------------ sign-in codes */

const CODE_RE = /^[0-9]{6}$/;
export const codeShapeOk = (c) => CODE_RE.test(String(c || ''));
// Hashing the PAIR binds a code to its address: digits read off one person's
// screen are worth nothing under another's.
const codeHash = (email, code) => hashToken(`${email}:${code}`);

/**
 * Start a sign-in. Returns what happened, for the caller to decide what to
 * EMAIL — never what to show, which is always the same.
 *   'code'      an active account (or a super): { code } to send
 *   'requested' a new address on an allowed domain: a pending request was recorded
 *   'pending'   already waiting on approval
 *   'none'      anything else (suspended, other domain, database error)
 */
export async function startSignIn(d, email, ipHash) {
  if (!d || !email) return { state: 'none' };
  let user = await findUser(d, email);
  if (!user && isSuper(email)) {
    // A super signs in before any admin exists: their row is created active.
    await rest(d, 'POST', 'texc_users', { email, role: 'admin', status: 'active', approved_at: nowIso(), approved_by: 'ACCOUNT_SUPERS' }, { prefer: 'return=minimal' });
    user = await findUser(d, email);
  }
  if (user && (user.status === 'active' || isSuper(email))) {
    // Only the newest code is live.
    await rest(d, 'PATCH', `texc_login_tokens?email=eq.${enc(email)}&consumed_at=is.null`, { consumed_at: nowIso() }, { prefer: 'return=minimal' });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const r = await rest(d, 'POST', 'texc_login_tokens', { token_hash: codeHash(email, code), email, expires_at: inMs(CODE_MINUTES * 60000), ip_hash: ipHash || null }, { prefer: 'return=minimal' });
    return r.ok ? { state: 'code', code } : { state: 'none' };
  }
  if (user && user.status === 'pending') return { state: 'pending' };
  if (!user && domainAllowed(email)) {
    const r = await rest(d, 'POST', 'texc_users', { email, role: 'viewer', status: 'pending' }, { prefer: 'return=minimal' });
    return r.ok ? { state: 'requested' } : { state: 'none' };
  }
  return { state: 'none' };
}

/** Spend a code. Conditional update, so two tabs racing one code cannot both win. */
export async function consumeCode(d, email, code) {
  if (!d || !email || !codeShapeOk(code)) return false;
  const r = await rest(d, 'PATCH', `texc_login_tokens?token_hash=eq.${codeHash(email, code)}&consumed_at=is.null&expires_at=gt.${enc(nowIso())}`, { consumed_at: nowIso() });
  return r.ok && Array.isArray(r.json) && r.json.length === 1;
}

/* ---------------------------------------------------------------- sessions */

export async function createSession(d, email, req) {
  const token = randomBytes(32).toString('hex');
  const r = await rest(d, 'POST', 'texc_user_sessions', {
    token_hash: hashToken(token), email, expires_at: inMs(SESSION_DAYS * 86400000),
    device: deviceFamily((req.headers || {})['user-agent']), last_seen_at: nowIso(),
  }, { prefer: 'return=minimal' });
  if (!r.ok) return '';
  rest(d, 'PATCH', `texc_users?email=eq.${enc(email)}`, { last_seen_at: nowIso() }, { prefer: 'return=minimal' });
  return token;
}

export const sessionCookie = (token) => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function sessionToken(req) {
  const t = parseCookies(req)[SESSION_COOKIE] || '';
  return /^[a-f0-9]{64}$/.test(t) ? t : '';
}

/** The signed-in person, or null. Two reads, both fail closed. */
export async function accountFor(req, d) {
  const token = sessionToken(req);
  if (!token || !d) return null;
  const sess = await one(d, `texc_user_sessions?token_hash=eq.${hashToken(token)}&revoked_at=is.null&expires_at=gt.${enc(nowIso())}&select=email`);
  if (!sess) return null;
  const user = await findUser(d, sess.email);
  if (!user) return null;
  if (user.status !== 'active' && !isSuper(user.email)) return null;
  return { email: user.email, name: user.name || '', role: effectiveRole(user) };
}

export async function revokeSession(d, req) {
  const token = sessionToken(req);
  if (!d || !token) return;
  await rest(d, 'PATCH', `texc_user_sessions?token_hash=eq.${hashToken(token)}&revoked_at=is.null`, { revoked_at: nowIso() }, { prefer: 'return=minimal' });
}

export async function revokeAllFor(d, email) {
  await rest(d, 'PATCH', `texc_user_sessions?email=eq.${enc(email)}&revoked_at=is.null`, { revoked_at: nowIso() }, { prefer: 'return=minimal' });
  await rest(d, 'PATCH', `texc_login_tokens?email=eq.${enc(email)}&consumed_at=is.null`, { consumed_at: nowIso() }, { prefer: 'return=minimal' });
}

/**
 * Gate an endpoint. Returns the person, or answers the request and returns
 * null: 401 for an API call with no session, 403 below the role, and for a
 * page, a redirect to sign in that brings them back.
 */
export async function requireRole(req, res, d, min, { page = false, next = '' } = {}) {
  const who = await accountFor(req, d);
  if (who && atLeast(who.role, min)) return who;
  res.setHeader('Cache-Control', 'no-store');
  if (page) {
    if (who) { res.status(403).setHeader('Content-Type', 'text/plain; charset=utf-8'); res.send('Your account cannot open this page. Ask an administrator.'); return null; }
    // Behind a rewrite req.url is the function's own path, so pages pass the address the person asked for.
    const back = /^\/[a-z0-9/-]*$/.test(next) ? next : '/editor';
    res.statusCode = 302;
    res.setHeader('Location', `/signin?next=${encodeURIComponent(back)}`);
    res.end();
    return null;
  }
  res.status(who ? 403 : 401).json({ error: who ? 'Your account cannot do this.' : 'Sign in again.' });
  return null;
}

/* ------------------------------------------------------------------ people */

export async function activeApprovers(d) {
  const r = await rest(d, 'GET', 'texc_users?status=eq.active&role=eq.admin&select=email');
  const stored = r.ok && Array.isArray(r.json) ? r.json.map((u) => u.email) : [];
  return [...new Set([...superEmails(), ...stored])];
}

export async function listUsers(d) {
  const r = await rest(d, 'GET', 'texc_users?select=email,name,role,status,created_at,approved_at,approved_by,last_seen_at&order=created_at.desc&limit=200');
  return r.ok && Array.isArray(r.json) ? r.json.map((u) => ({ ...u, role: effectiveRole(u) })) : [];
}

/**
 * Change an account. An admin manages editors and viewers; only a super may
 * make or touch an admin. Nobody can change a super (it is not stored).
 * Losing access takes hold now: sessions and outstanding codes are revoked.
 */
export async function setUser(d, who, email, patch) {
  const target = await findUser(d, email);
  if (!target) return { ok: false, error: 'There is no account for that address.' };
  const targetRole = effectiveRole(target);
  if (targetRole === 'super') return { ok: false, error: 'A Brand in Black account is managed in the deployment, not here.' };
  const isSup = who.role === 'super';
  if (!isSup && (targetRole === 'admin' || patch.role === 'admin')) return { ok: false, error: 'Only Brand in Black can make or change an administrator.' };
  if (!atLeast(who.role, 'admin')) return { ok: false, error: 'Your account cannot do this.' };
  const body = {};
  if (['admin', 'editor', 'viewer'].includes(patch.role)) body.role = patch.role;
  if (['pending', 'active', 'suspended'].includes(patch.status)) {
    body.status = patch.status;
    if (patch.status === 'active' && target.status !== 'active') { body.approved_at = nowIso(); body.approved_by = who.email; }
  }
  if (typeof patch.name === 'string') body.name = patch.name.trim().slice(0, 80);
  if (!Object.keys(body).length) return { ok: false, error: 'Nothing to change.' };
  const r = await rest(d, 'PATCH', `texc_users?email=eq.${enc(email)}`, body, { prefer: 'return=minimal' });
  if (!r.ok) return { ok: false, error: 'That could not be saved. Try again.' };
  if ((body.status && body.status !== 'active') || (body.role && RANK[body.role] < RANK[targetRole])) await revokeAllFor(d, email);
  return { ok: true, approved: body.status === 'active' && target.status !== 'active' };
}

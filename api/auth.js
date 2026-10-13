/**
 * Sign in, sign out, who am I.
 *
 *   POST /api/auth?action=code     { email }          → always { ok: true }
 *   POST /api/auth?action=verify   { email, code }    → { ok, next } and a session cookie
 *   POST /api/auth?action=signout                     → { ok }
 *   GET  /api/auth?action=me                          → { email, name, role } or 401
 *
 * action=code answers IDENTICALLY for every address (lib/accounts.js rule 1).
 * Six digits is a million guesses, so the attempt ceiling on verify is the
 * security property: ten per address per code lifetime, counted BEFORE the
 * code is checked, and failing CLOSED.
 */
import { db } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { rateLimited, limitStrict, keyedHash, callerHash, tooMany } from '../lib/ratelimit.js';
import { sendEmail, layout } from '../lib/notify-email.js';
import { BRAND } from '../lib/brand.js';
import {
  normEmail, startSignIn, consumeCode, codeShapeOk, createSession, sessionCookie, clearedCookie,
  revokeSession, accountFor, findUser, isSuper, activeApprovers,
} from '../lib/accounts.js';
import { baseUrl } from '../lib/proposals.js';

export const config = { maxDuration: 10 };

const CODE_PER_CALLER = 6;   // per 5 minutes
const CODE_PER_EMAIL = 3;    // per 10 minutes
const VERIFY_PER_EMAIL = 10; // per 15 minutes (one code's lifetime)
const VERIFY_PER_CALLER = 30;

const safeNext = (n) => (typeof n === 'string' && /^\/editor(\/[0-9a-f-]{36})?$/.test(n) ? n : '/editor');

export default async function handler(req, res) {
  noStore(res);
  const action = String((req.query || {}).action || '');
  const d = db();
  if (!d) { res.status(503).json({ error: 'Not configured.' }); return; }

  if (action === 'me') {
    if (onlyMethods(req, res, ['GET'])) return;
    const who = await accountFor(req, d);
    if (!who) { res.status(401).json({ error: 'Not signed in.' }); return; }
    res.status(200).json(who);
    return;
  }
  if (onlyMethods(req, res, ['POST']) || refuseCrossSite(req, res)) return;
  const b = body(req, 4000);

  if (action === 'code') {
    const email = normEmail(b.email);
    if (await rateLimited(d, req, 'signin-code', CODE_PER_CALLER, 300)) { tooMany(res); return; }
    if (email && !(await rateLimited(d, { headers: {} }, `signin-mail:${keyedHash(email)}`, CODE_PER_EMAIL, 600))) {
      const out = await startSignIn(d, email, callerHash(req));
      await mailFor(d, email, out);
    }
    // The same answer, whatever happened.
    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'verify') {
    const email = normEmail(b.email);
    const code = String(b.code || '').replace(/\s+/g, '');
    if (await rateLimited(d, req, 'signin-verify', VERIFY_PER_CALLER, 300)) { tooMany(res); return; }
    if (!email || !codeShapeOk(code)) { res.status(400).json({ error: 'That code did not work. Check it, or ask for a new one.' }); return; }
    if (await limitStrict(d, `signin-guess:${keyedHash(email)}`, VERIFY_PER_EMAIL, 900)) { tooMany(res); return; }
    const spent = await consumeCode(d, email, code);
    const user = spent ? await findUser(d, email) : null;
    if (!spent || !user || (user.status !== 'active' && !isSuper(email))) {
      res.status(400).json({ error: 'That code did not work. Check it, or ask for a new one.' });
      return;
    }
    const token = await createSession(d, email, req);
    if (!token) { res.status(503).json({ error: 'Signing in failed. Try again.' }); return; }
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.status(200).json({ ok: true, next: safeNext(b.next) });
    return;
  }

  if (action === 'signout') {
    await revokeSession(d, req);
    res.setHeader('Set-Cookie', clearedCookie());
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Unknown action.' });
}

/** What to email, by what happened. Only the inbox's owner ever sees the difference. */
async function mailFor(d, email, out) {
  const signin = `${baseUrl()}/signin`;
  if (out.state === 'code') {
    const spaced = `${out.code.slice(0, 3)} ${out.code.slice(3)}`;
    const mail = layout({
      heading: 'Your sign-in code',
      paras: [`Type this into the ${BRAND.name} Proposals page you started on. It works once and expires in 15 minutes.`],
      code: spaced,
      foot: 'If you did not ask for it, ignore this email. A code is useless to anyone not at your screen.',
    });
    await sendEmail({ to: email, subject: `Your sign-in code: ${out.code}`, ...mail });
  } else if (out.state === 'requested') {
    const approvers = await activeApprovers(d);
    const mail = layout({
      heading: 'Your request is in',
      paras: [`Access to ${BRAND.name} Proposals is approved by hand, because it holds client proposals.`,
        approvers.length ? 'You will get an email as soon as it is approved.' : 'Nobody can approve accounts yet. Ask Brand in Black to set up your access.'],
    });
    await sendEmail({ to: email, subject: `${BRAND.name} Proposals: access requested`, ...mail });
    if (approvers.length) {
      const alert = layout({ heading: 'Someone has asked for access', paras: [`${email} asked to use ${BRAND.name} Proposals. They can see nothing until an administrator approves them.`], button: { label: 'Review people', href: `${baseUrl()}/editor#people` } });
      await sendEmail({ to: approvers, subject: `${email} has asked for access`, ...alert });
    }
  } else if (out.state === 'pending') {
    const mail = layout({ heading: 'Still waiting on approval', paras: ['Your access has not been approved yet. An administrator has been told.'], button: { label: 'Sign in page', href: signin } });
    await sendEmail({ to: email, subject: `${BRAND.name} Proposals: still waiting on approval`, ...mail });
  }
}

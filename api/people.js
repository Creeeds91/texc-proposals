/**
 * Staff accounts, for administrators.
 *
 *   GET  /api/people                                → { people: [...], me }
 *   POST { email, role?, status?, name? }           → { ok }
 *
 * An admin approves and manages editors and viewers; only Brand in Black (a
 * super, from ACCOUNT_SUPERS) can make or change an administrator.
 */
import { db } from '../lib/db.js';
import { body, refuseCrossSite, onlyMethods, noStore } from '../lib/http.js';
import { requireRole, listUsers, setUser, normEmail } from '../lib/accounts.js';
import { recordAudit } from '../lib/events.js';
import { sendEmail, layout } from '../lib/notify-email.js';
import { BRAND } from '../lib/brand.js';
import { baseUrl } from '../lib/proposals.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  noStore(res);
  if (onlyMethods(req, res, ['GET', 'POST'])) return;
  const d = db();
  const who = await requireRole(req, res, d, 'admin');
  if (!who) return;
  if (req.method === 'GET') { res.status(200).json({ people: await listUsers(d), me: who }); return; }
  if (refuseCrossSite(req, res)) return;
  const b = body(req, 4000);
  const email = normEmail(b.email);
  if (!email) { res.status(400).json({ error: 'Which account?' }); return; }
  if (email === who.email) { res.status(400).json({ error: 'You cannot change your own account.' }); return; }
  const out = await setUser(d, who, email, { role: b.role, status: b.status, name: b.name });
  if (!out.ok) { res.status(400).json({ error: out.error }); return; }
  await recordAudit(d, req, who, 'person_changed', { target: email, detail: { role: b.role || null, status: b.status || null } });
  if (out.approved) {
    const mail = layout({ heading: 'You can sign in now', paras: [`Your access to ${BRAND.name} Proposals has been approved.`], button: { label: 'Sign in', href: `${baseUrl()}/signin` } });
    await sendEmail({ to: email, subject: `${BRAND.name} Proposals: you have access`, ...mail });
  }
  res.status(200).json({ ok: true });
}

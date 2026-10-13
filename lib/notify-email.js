/**
 * Transactional email through SMTP2GO's HTTP API (the studio standard).
 *
 *   SMTP2GO_API_KEY   the API key
 *   MAIL_FROM         the sender, e.g. "TEXC Proposals <proposals@texc.au>" (C27: SPF/DKIM first)
 *   MAIL_OUTBOX       local and tests only: a file path; mail is appended there
 *                     as JSON lines instead of being sent
 *
 * sendEmail() never throws: it answers { ok, reason }. Callers decide whether a
 * failed send matters (a sign-in code does; a first-open notice does not).
 */
import { appendFileSync } from 'node:fs';
import { BRAND } from './brand.js';

export function emailConfigured() {
  return !!(process.env.MAIL_OUTBOX || (process.env.SMTP2GO_API_KEY && process.env.MAIL_FROM));
}

export async function sendEmail({ to, subject, text, html }) {
  const list = (Array.isArray(to) ? to : [to]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'no recipient' };
  if (process.env.MAIL_OUTBOX) {
    try {
      appendFileSync(process.env.MAIL_OUTBOX, JSON.stringify({ at: new Date().toISOString(), to: list, subject, text, html }) + '\n');
      return { ok: true };
    } catch { return { ok: false, reason: 'outbox not writable' }; }
  }
  const key = process.env.SMTP2GO_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) return { ok: false, reason: 'email not configured' };
  try {
    const r = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': key },
      body: JSON.stringify({ sender: from, to: list, subject, text_body: text, html_body: html }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && j && j.data && j.data.succeeded >= 1 ? { ok: true } : { ok: false, reason: `send failed (${r.status})` };
  } catch {
    return { ok: false, reason: 'send failed' };
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The house layout for every email: ink header with the business name, plain
 * paragraphs, an optional button and an optional boxed code. Inline styles
 * are unavoidable in email; the colours come from lib/brand.js.
 */
export function layout({ heading, paras = [], button, code, foot }) {
  const c = BRAND.colours;
  const p = (t) => `<p style="font-size:14px;line-height:1.6;color:#333;margin:0 0 14px">${esc(t)}</p>`;
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:${c.ink}">`
    + `<div style="background:${c.ink};border-bottom:2px solid ${c.gold};padding:16px 20px;margin:0 0 22px">`
    + `<span style="color:${c.gold};font-size:16px;font-weight:700;letter-spacing:.08em">${esc(BRAND.name)}</span></div>`
    + `<h1 style="font-size:19px;margin:0 0 12px">${esc(heading)}</h1>`
    + paras.map(p).join('')
    + (code ? `<p style="margin:0 0 18px"><span style="display:inline-block;border:1px solid #ddd;padding:12px 20px;font-size:28px;font-weight:700;letter-spacing:.2em;font-family:Menlo,Consolas,monospace">${esc(code)}</span></p>` : '')
    + (button ? `<p style="margin:6px 0 20px"><a href="${esc(button.href)}" style="background:${c.gold};color:${c.ink};text-decoration:none;padding:12px 20px;font-weight:700;font-size:14px;display:inline-block">${esc(button.label)}</a></p>` : '')
    + (foot ? `<p style="font-size:12px;line-height:1.6;color:#777;margin:18px 0 0">${esc(foot)}</p>` : '')
    + `<p style="font-size:12px;color:#777;margin:18px 0 0">${esc(BRAND.legalName)} · ABN ${esc(BRAND.abn)} · ${esc(BRAND.web)}</p></div>`;
  const textBody = [heading, '', ...paras, code ? `\n    ${code}\n` : '', button ? `${button.label}: ${button.href}` : '', foot || '', '', `${BRAND.legalName} · ABN ${BRAND.abn}`]
    .filter((x) => x !== undefined).join('\n');
  return { html, text: textBody };
}

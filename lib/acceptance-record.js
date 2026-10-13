/**
 * The acceptance record: one self-contained HTML page per acceptance, rendered
 * and stored at the moment of acceptance (texc-acceptances bucket) and
 * fingerprinted (texc_acceptances.record_sha256). It is what was accepted, by
 * whom, when, with which sentences, quotation and signature — printable from
 * the archive, and never regenerated.
 *
 * Self-contained so the stored file stands alone as evidence: one style block
 * (allowed by its hash, RECORD_CSP), the drawn signature as a data: image, no
 * script, no external request. Every value from a person is escaped.
 */
import { createHash } from 'node:crypto';
import { BRAND } from './brand.js';
import { BASES, lineAmountCents, formatAUD, formatQty } from '../assets/js/money.js';

const C = BRAND.colours;
const STYLE = [
  '*{box-sizing:border-box}',
  `body{margin:0;background:${C.paper};color:${C.ink};font:14px/1.55 "Helvetica Neue",Arial,sans-serif}`,
  '.page{max-width:820px;margin:0 auto;padding:32px 28px 48px;background:#fff}',
  `.band{background:${C.ink};color:#fff;padding:18px 22px;border-bottom:3px solid ${C.gold};display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}`,
  `.band b{color:${C.gold};font-size:18px;letter-spacing:.12em}`,
  '.band span{font-size:12px;letter-spacing:.16em;text-transform:uppercase}',
  'h1{font-size:24px;line-height:1.2;margin:26px 0 4px}',
  `.sub{color:#555;margin:0 0 22px}`,
  `h2{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:${C.goldOnPaper};margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:6px}`,
  'dl{display:grid;grid-template-columns:190px 1fr;gap:6px 16px;margin:0}',
  'dt{color:#555}dd{margin:0;font-weight:600}',
  '.tick{margin:0 0 8px;padding-left:26px;position:relative}',
  `.tick:before{content:"\\2713";position:absolute;left:0;top:0;width:18px;height:18px;border:1.5px solid ${C.ink};font-size:13px;line-height:16px;text-align:center}`,
  `.framing{border-left:3px solid ${C.gold};padding:8px 14px;background:${C.paper};margin:12px 0 0}`,
  'table{width:100%;border-collapse:collapse;font-size:13px}',
  'th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}',
  'th{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#555}',
  'td.n,th.n{text-align:right;white-space:nowrap}',
  '.off td{color:#999;text-decoration:line-through}',
  'tfoot td{font-weight:700;border-bottom:0}',
  `.sig{border:1px solid #ccc;padding:12px;display:inline-block;min-width:320px;background:#fff}`,
  '.sig img{display:block;max-width:100%;height:auto;max-height:160px}',
  '.typed{font:italic 26px Georgia,"Times New Roman",serif;margin:4px 0}',
  '.staff{border:1px solid #ccc;background:#fafafa;padding:10px 14px}',
  '.mono{font-family:Menlo,Consolas,monospace;font-size:12px;word-break:break-all;font-weight:400}',
  '.foot{margin-top:32px;font-size:12px;color:#666;border-top:1px solid #ddd;padding-top:10px}',
  '@media print{body{background:#fff}.page{padding:0;max-width:none}.band{-webkit-print-color-adjust:exact;print-color-adjust:exact}}',
].join('');

export const RECORD_STYLE = STYLE;
const styleHash = createHash('sha256').update(STYLE, 'utf8').digest('base64');
/** The record page's own policy: its one style block, its embedded signature, nothing else. */
export const RECORD_CSP = `default-src 'none'; style-src 'sha256-${styleHash}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const hobartTime = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));

/**
 * r: { id, kind, acceptedAt, reference, rev, project, site, clientCompany,
 *      signer: { name, position, company, email },
 *      clauses: { authority, accept }, hp1Framing, termsVersion,
 *      lines, options, totals,
 *      signature: { kind, png (base64) | null, typed | null },
 *      evidence: { plaintextSha256, encSha256, ipHash, uaFamily, session },
 *      staff: { recordedBy, note } | null }
 */
export function renderRecord(r) {
  const chosen = new Set(r.options || []);
  const rows = (r.lines || []).map((l) => {
    const off = l.optional && !chosen.has(l.id);
    let amount = '';
    try { const a = lineAmountCents(l); amount = a == null ? 'At cost' : formatAUD(a); } catch { amount = '—'; }
    const qty = Number.isSafeInteger(l.qtyHundredths) ? `${formatQty(l.qtyHundredths)} ${esc(l.unit || '')}`.trim() : '';
    const rate = Number.isSafeInteger(l.rateCents) ? formatAUD(l.rateCents) : '';
    const label = `${esc(l.desc)}${l.optional ? ` <em>(optional — ${off ? 'not chosen' : 'chosen'})</em>` : ''}`;
    return `<tr${off ? ' class="off"' : ''}><td>${label}</td><td>${esc(BASES[l.basis] || l.basis || '')}</td><td class="n">${qty}</td><td class="n">${esc(rate)}</td><td class="n">${esc(amount)}</td></tr>`;
  }).join('');
  const t = r.totals || {};
  const unpriced = t.unpriced ? `<tr><td colspan="5">Plus ${t.unpriced === 1 ? 'one item' : `${t.unpriced} items`} at cost + GST.</td></tr>` : '';
  const sig = r.signature || {};
  const signer = r.signer || {};
  const ev = r.evidence || {};
  const isStaff = r.kind === 'staff';

  const signatureBlock = isStaff
    ? `<div class="staff"><p><b>Recorded by staff</b> — ${esc(r.staff && r.staff.recordedBy)}</p><p>${esc(r.staff && r.staff.note)}</p></div>`
    : `<div class="sig">${sig.png ? `<img src="data:image/png;base64,${sig.png}" alt="Signature drawn by ${esc(signer.name)}">` : ''}${sig.typed ? `<p class="typed">${esc(sig.typed)}</p><p>Typed signature</p>` : ''}</div>`;

  const confirmations = isStaff
    ? `<p>Acceptance received outside the online proposal and recorded by ${esc(BRAND.legalName)}. The person accepting did not tick these sentences online:</p><p class="tick">${esc(r.clauses.authority)}</p><p class="tick">${esc(r.clauses.accept)}</p>`
    : `<p class="tick">${esc(r.clauses.authority)}</p><p class="tick">${esc(r.clauses.accept)}</p>`;

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Acceptance record — ${esc(r.reference)} Rev ${esc(r.rev)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="page">
<div class="band"><b>${esc(BRAND.name)}</b><span>Acceptance record</span></div>
<h1>${esc(r.project || 'Proposal')}</h1>
<p class="sub">${esc(r.reference)} · Revision ${esc(r.rev)} · Prepared for ${esc(r.clientCompany)}${r.site ? ` · ${esc(r.site)}` : ''}</p>

<h2>Accepted</h2>
<dl>
<dt>When</dt><dd>${esc(hobartTime(r.acceptedAt))} (Hobart)<br><span class="mono">${esc(r.acceptedAt)} UTC</span></dd>
<dt>By</dt><dd>${esc(signer.name)}${signer.position ? `, ${esc(signer.position)}` : ''}</dd>
<dt>Company</dt><dd>${esc(signer.company)}</dd>
${signer.email ? `<dt>Email</dt><dd>${esc(signer.email)}</dd>` : ''}
<dt>How</dt><dd>${isStaff ? 'Recorded by staff' : 'Online, on the proposal page'}</dd>
${r.termsVersion ? `<dt>Terms</dt><dd>Version ${esc(r.termsVersion)}</dd>` : ''}
</dl>

<h2>Confirmed</h2>
${confirmations}
<p class="framing">${esc(r.hp1Framing)}</p>

<h2>Quotation as accepted</h2>
<table>
<thead><tr><th>Item</th><th>Basis</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}${unpriced}</tbody>
<tfoot>
<tr><td colspan="4">Subtotal ex GST</td><td class="n">${esc(formatAUD(t.subtotal || 0))}</td></tr>
<tr><td colspan="4">GST</td><td class="n">${esc(formatAUD(t.gst || 0))}</td></tr>
<tr><td colspan="4">Total inc GST</td><td class="n">${esc(formatAUD(t.total || 0))}</td></tr>
</tfoot>
</table>

<h2>Signature</h2>
${signatureBlock}

<h2>Evidence</h2>
<dl>
<dt>Record</dt><dd class="mono">${esc(r.id)}</dd>
${ev.plaintextSha256 ? `<dt>Text accepted (SHA-256)</dt><dd class="mono">${esc(ev.plaintextSha256)}</dd>` : ''}
${ev.encSha256 ? `<dt>Revision as issued (SHA-256)</dt><dd class="mono">${esc(ev.encSha256)}</dd>` : ''}
${ev.uaFamily ? `<dt>Device</dt><dd>${esc(ev.uaFamily)}</dd>` : ''}
${ev.ipHash ? `<dt>Connection (keyed hash)</dt><dd class="mono">${esc(ev.ipHash)}</dd>` : ''}
${ev.session ? `<dt>Session</dt><dd class="mono">${esc(ev.session)}</dd>` : ''}
</dl>
${ev.plaintextSha256 ? '<p>The text fingerprint is of the exact proposal the person decrypted and read; it matches the published revision.</p>' : ''}

<p class="foot">${esc(BRAND.legalName)} · ABN ${esc(BRAND.abn)} · ${esc(BRAND.web)}</p>
</main>
</body>
</html>
`;
}

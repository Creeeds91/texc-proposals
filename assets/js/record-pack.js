/**
 * The record pack (Phase 9, docs/architecture.md §20): one proposal's whole
 * record in one zip, assembled in the staff member's browser from what the
 * server holds, and checked as it is assembled.
 *
 *   index.html                       the cover and index: read this first
 *   manifest.json                    every file, its SHA-256, and the fingerprint
 *                                    recorded for it at publishing or acceptance
 *   SHA256SUMS                       the same, for `sha256sum -c SHA256SUMS`
 *   revisions/<rev>/published.json   each revision's published text, byte for byte
 *   revisions/<rev>/readable.html    the same revision drawn as the client saw it,
 *                                    self-contained, for reading without this system
 *   documents/<name>-<sha>.pdf       every document any revision sent, as stored
 *   acceptances/rev-<rev>.html       each acceptance record (signature inside), as stored
 *   history.csv, history.json        every event, open and staff action, oldest first
 *
 * A file whose bytes do not match the fingerprint recorded for it is still
 * packed — the pack is evidence either way — and the mismatch is named on the
 * cover and in the manifest. Nothing here is written as HTML from the data
 * without escaping it.
 */
import { makeZip } from './zip.js';
import { csvText } from './csv.js';
import { sha256Hex } from './upload.js';

const D = document;
const enc = new TextEncoder();
const hobart = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const when = (iso) => (iso ? hobart.format(new Date(iso)) : '');
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugOf = (s, max = 60) => String(s || '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'file';
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const money = (cents) => (Number.isFinite(Number(cents)) && cents !== null ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(cents) / 100) : '');

async function bytesOf(url, opts = {}) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

function dataUrl(bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

const TYPES = { woff2: 'font/woff2', woff: 'font/woff', svg: 'image/svg+xml', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
const typeOf = (url, fallback) => TYPES[(new URL(url, location.href).pathname.split('.').pop() || '').toLowerCase()] || fallback;

/* ------------------------------------------------------- the readable copy */

/**
 * One revision drawn as the client saw it, frozen into a single file: the
 * staff view of it is opened in a frame on this page, drawn by the same
 * runtime, then copied with its styles, fonts, icons and photographs inlined
 * and every script removed. Its documents link into the pack.
 */
async function readableCopy(rev, docFiles, inlined) {
  const frame = D.createElement('iframe');
  frame.className = 'arc-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.title = 'Record pack: drawing a revision';
  const loaded = new Promise((done, fail) => {
    frame.addEventListener('load', done, { once: true });
    setTimeout(() => fail(new Error('timeout')), 45000);
  });
  frame.src = `/staff/revision/${encodeURIComponent(rev.id)}`;
  D.body.append(frame);
  try {
    await loaded;
    const win = frame.contentWindow;
    const ok = await Promise.race([win.revisionReady, new Promise((done) => setTimeout(() => done(false), 45000))]);
    if (!ok) throw new Error('The revision could not be drawn.');
    const live = frame.contentDocument;
    live.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('rv-in'));
    live.querySelectorAll('details').forEach((d) => { d.open = true; });
    // The copy is worked on in an inert document — one with no window, which
    // fetches and runs nothing — never in the frame. Styles the runtime set on
    // elements travel as data-pack-style until the copy is written out, so no
    // page here ever holds an inline style its policy would refuse.
    live.querySelectorAll('[style]').forEach((n) => { n.setAttribute('data-pack-style', n.getAttribute('style')); n.removeAttribute('style'); });
    const doc = new DOMParser().parseFromString(`<!doctype html>${live.documentElement.outerHTML}`, 'text/html');
    return await freeze(doc.documentElement, doc, rev, docFiles, inlined);
  } finally {
    frame.remove();
  }
}

async function inline(url, inlined, fallbackType) {
  const abs = new URL(url, location.href).href;
  if (!inlined.has(abs)) inlined.set(abs, bytesOf(abs).then((b) => dataUrl(b, typeOf(abs, fallbackType))).catch(() => ''));
  return inlined.get(abs);
}

async function inlineCss(href, inlined) {
  const abs = new URL(href, location.href).href;
  let css = new TextDecoder().decode(await bytesOf(abs));
  const refs = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]).filter((u) => !/^(data:|#)/.test(u)))];
  for (const ref of refs) {
    const target = new URL(ref, abs).href;
    const data = await inline(target, inlined, 'application/octet-stream');
    if (data) css = css.split(ref).join(data);
  }
  return css;
}

function pickCandidate(srcset) {
  const cands = String(srcset || '').split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]).map(([u, w]) => [parseInt(w, 10) || 0, u]).sort((a, b) => a[0] - b[0]);
  if (!cands.length) return '';
  const fit = cands.filter(([w]) => w <= 1600);
  return (fit.length ? fit[fit.length - 1] : cands[0])[1];
}

async function freeze(root, doc, rev, docFiles, inlined) {
  const R = root;
  R.classList.remove('motion');
  R.removeAttribute('data-boot');
  R.querySelectorAll('script, link[rel="preload"], link[rel="icon"], #staff-strip, #gate, dialog, .arc-frame').forEach((n) => n.remove());
  // Styles: each stylesheet inlined, with its fonts and images (written in
  // where its marker stands once the copy is text).
  const sheets = [];
  for (const link of [...R.querySelectorAll('link[rel="stylesheet"]')]) {
    const href = link.getAttribute('href') || '';
    if (/revision-view\.css$/.test(href)) { link.remove(); continue; }
    sheets.push({ media: link.getAttribute('media') || '', css: (await inlineCss(href, inlined)).replace(/<\/style/gi, '') });
    link.replaceWith(doc.createComment(`pack-css:${sheets.length - 1}`));
  }
  // Icons: the sprite once, in the page; every <use> points into it.
  const sprite = '/assets/img/icons.svg';
  const uses = [...R.querySelectorAll('use')].filter((u) => (u.getAttribute('href') || '').startsWith(sprite));
  if (uses.length) {
    const text = new TextDecoder().decode(await bytesOf(sprite));
    const holder = doc.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.className = 'pack-sprite';
    holder.innerHTML = text.replace(/<\?xml[^>]*>/, '').replace(/<svg\b/, '<svg width="0" height="0" focusable="false"');
    R.querySelector('body').prepend(holder);
    uses.forEach((u) => u.setAttribute('href', '#' + u.getAttribute('href').split('#')[1]));
  }
  // Pictures: the one the page would show at desktop width, inlined. Hidden ones are dropped.
  for (const img of [...R.querySelectorAll('img')]) {
    const hidden = img.closest('[hidden]');
    const src = img.getAttribute('srcset') ? pickCandidate(img.getAttribute('srcset')) : img.getAttribute('src');
    ['srcset', 'sizes', 'loading', 'decoding', 'fetchpriority'].forEach((a) => img.removeAttribute(a));
    if (hidden || !src || src.startsWith('data:')) { if (hidden) img.removeAttribute('src'); continue; }
    const data = await inline(src, inlined, 'image/webp');
    if (data) img.setAttribute('src', data); else img.removeAttribute('src');
  }
  // Documents: View and Download become links into the pack.
  for (const b of [...R.querySelectorAll('[data-attachment]')]) {
    const file = docFiles.get(b.dataset.attachment);
    const a = doc.createElement('a');
    a.className = b.className;
    a.append(...b.childNodes);
    if (file) {
      a.href = `../../${file}`;
      if (b.dataset.action === 'download') a.setAttribute('download', '');
    } else {
      a.setAttribute('aria-disabled', 'true');
    }
    b.replaceWith(a);
  }
  R.querySelectorAll('[data-print], #index-toggle').forEach((n) => n.remove());
  R.querySelectorAll('button, input, textarea, select').forEach((n) => n.setAttribute('disabled', ''));
  // Nothing in this file may fetch or run anything, wherever it is opened.
  const head = R.querySelector('head');
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";
  head.prepend(policy);
  const charset = head.querySelector('meta[charset]');
  if (charset) head.prepend(charset);
  const note = doc.createElement('div');
  note.className = 'pack-note';
  note.setAttribute('role', 'note');
  note.setAttribute('data-pack-style', 'font:14px/1.5 system-ui,sans-serif;background:var(--white);color:var(--ink);border-bottom:3px solid var(--gold);padding:12px 16px');
  note.textContent = `Readable copy of revision ${rev.rev}, drawn from its published text for the record pack. The record itself is published.json beside this file (SHA-256 ${rev.plaintextSha256}).`;
  R.querySelector('body').prepend(note);
  return '<!doctype html>\n' + R.outerHTML
    .replace(/<!--pack-css:(\d+)-->/g, (m, i) => `<style${sheets[i].media ? ` media="${esc(sheets[i].media)}"` : ''}>${sheets[i].css}</style>`)
    .replace(/ data-pack-style="/g, ' style="');
}

/* ------------------------------------------------------------ the cover */

function coverHtml(m) {
  const p = m.proposal;
  const ok = (c) => (c.matches === true ? '<span class="ok">matches</span>' : c.matches === false ? '<strong class="bad">DOES NOT MATCH</strong>' : '<strong class="bad">MISSING</strong>');
  const rowsRev = m.revisions.map((r) => `<tr><td><strong>${esc(r.rev)}</strong></td><td>${esc(when(r.publishedAt))}<br><span class="m">${esc(r.publishedBy || '')}</span></td>
    <td>${r.withdrawnAt ? `Withdrawn ${esc(when(r.withdrawnAt))}` : r.supersededAt ? `Superseded ${esc(when(r.supersededAt))}` : 'Current when packed'}${r.note ? `<br><span class="m">${esc(r.note)}</span>` : ''}</td>
    <td><a href="${esc(r.readable || '')}">${r.readable ? 'Read it' : 'not drawn'}</a> · <a href="${esc(r.published)}">published.json</a><br>${ok(r.check)}</td>
    <td>${r.documents.length ? r.documents.map((d) => `<a href="${esc(d.file || '')}">${esc(d.title || d.name)}</a> ${ok(d.check)}`).join('<br>') : '<span class="m">none</span>'}</td></tr>`).join('');
  const rowsAcc = m.acceptances.length ? m.acceptances.map((a) => `<tr><td><strong>${esc(a.rev)}</strong></td><td>${esc(when(a.accepted_at))}</td>
    <td>${esc([a.name, a.position, a.company].filter(Boolean).join(', '))}${a.kind === 'staff' ? `<br><span class="m">Recorded by staff (${esc(a.recorded_by || '')}): ${esc(a.staff_note || '')}</span>` : ''}</td>
    <td>${esc(money(a.accepted_total_cents))}</td><td><a href="${esc(a.file || '')}">Acceptance record</a><br>${ok(a.check)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="m">Not accepted.</td></tr>';
  const bad = m.checks.filter((c) => c.matches !== true);
  const keep = m.retention;
  const keepLine = [
    keep.archiveAfterDays ? `Expired, unaccepted proposals are archived ${keep.archiveAfterDays} days on.` : 'No automatic archiving period was set.',
    keep.keepAcceptedYears ? `Accepted proposals are kept ${keep.keepAcceptedYears} years after acceptance.` : 'No keeping period for accepted proposals was set: they are kept.',
  ].join(' ');
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Record pack · ${esc(p.reference || p.project)}</title>
<style>${m.tokensCss}</style>
<style>
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper);margin:0}
main{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.02em}h2{font-size:17px;margin:32px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.m{color:var(--ink-on-paper-muted);font-size:13px}.ok{color:var(--go);font-weight:600}.bad{color:var(--stop)}
.card{background:var(--white);border:1px solid var(--doc-rule);border-radius:6px;padding:16px 18px}
.verdict{border-left:4px solid ${bad.length ? 'var(--stop)' : 'var(--go)'}}
table{width:100%;border-collapse:collapse;background:var(--white);border:1px solid var(--doc-rule);font-size:14px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--doc-rule)}th{background:var(--doc-page);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
dl{display:grid;grid-template-columns:200px 1fr;gap:4px 16px;margin:0}dt{color:var(--ink-on-paper-muted)}dd{margin:0}
a{color:var(--doc-gold-text)}code{font-size:12px;word-break:break-all}
@media (max-width:700px){dl{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
</style></head><body><main>
<p class="m">${esc(m.brand)} · Record pack</p>
<h1>${esc(p.reference || 'Unissued proposal')}</h1>
<p><strong>${esc(p.project || '')}</strong> · ${esc(p.client_company || '')}${p.site_locality ? ` · ${esc(p.site_locality)}` : ''}${p.site_region ? `, ${esc(p.site_region)}` : ''}</p>
<div class="card verdict"><strong>${bad.length ? `${bad.length} of ${m.checks.length} recorded fingerprints do not match, or their file could not be fetched.` : `All ${m.checks.length} recorded fingerprints match.`}</strong>
<p class="m">Each revision's published text is compared with the SHA-256 recorded when it was published; each document with the one in that revision's snapshot; each acceptance record with the one written when it was accepted. manifest.json lists every file; SHA256SUMS lets anyone check them again with <code>sha256sum -c SHA256SUMS</code>.</p>
${bad.length ? `<ul>${bad.map((c) => `<li class="bad">${esc(c.path || c.what)}: ${c.matches === false ? 'does not match' : esc(c.error || 'missing')}</li>`).join('')}</ul>` : ''}</div>
<h2>The proposal</h2>
<div class="card"><dl>
<dt>Services</dt><dd>${esc((p.services || []).map((s) => m.services[s] || s).join(', '))}</dd>
<dt>Created</dt><dd>${esc(when(p.created_at))}${p.created_by ? ` by ${esc(p.created_by)}` : ''}</dd>
<dt>First issued</dt><dd>${esc(when(p.issued_at)) || '—'}</dd>
<dt>Valid until</dt><dd>${esc(p.valid_until || '—')}</dd>
<dt>Accepted</dt><dd>${esc(when(p.accepted_at)) || 'No'}</dd>
<dt>Archived</dt><dd>${p.archived_at ? `${esc(when(p.archived_at))}${p.archived_by ? ` by ${esc(p.archived_by)}` : ''}${p.archive_reason ? `: ${esc(p.archive_reason)}` : ''}` : 'No'}</dd>
<dt>Keeping periods</dt><dd>${esc(keepLine)}</dd>
<dt>Pack made</dt><dd>${esc(when(m.generatedAt))} by ${esc(m.generatedBy)}</dd>
</dl></div>
<h2>Revisions</h2>
<table><thead><tr><th>Rev</th><th>Sent</th><th>Since</th><th>The revision</th><th>Documents it sent</th></tr></thead><tbody>${rowsRev}</tbody></table>
<h2>Acceptance</h2>
<table><thead><tr><th>Rev</th><th>When</th><th>Who</th><th>Total inc GST</th><th>Record</th></tr></thead><tbody>${rowsAcc}</tbody></table>
<h2>History</h2>
<p class="card">${m.historyCount} entries, oldest first: <a href="history.csv">history.csv</a> (for a spreadsheet) and <a href="history.json">history.json</a> (as recorded).</p>
</main></body></html>
`;
}

/* ------------------------------------------------------------ the history */

function historyRows(pack) {
  const rows = [
    ...pack.events.map((e) => ({ at: e.created_at, source: e.actor ? 'staff' : 'client', rev: e.rev, what: e.event, who: e.actor || '', detail: e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : '' })),
    ...pack.views.map((v) => ({ at: v.created_at, source: 'client', rev: v.rev, what: 'opened', who: '', detail: [v.device, v.region].filter(Boolean).join(' · ') })),
    ...pack.audit.map((a) => ({ at: a.created_at, source: a.role === 'system' ? 'system' : 'staff', rev: '', what: a.action, who: a.actor, detail: [a.target, a.detail && Object.keys(a.detail).length ? JSON.stringify(a.detail) : ''].filter(Boolean).join(' · ') })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return [['When (UTC)', 'When (Hobart)', 'From', 'Revision', 'What', 'Who', 'Detail'], ...rows.map((r) => [r.at, when(r.at), r.source, r.rev || '', r.what, r.who, r.detail])];
}

/* ----------------------------------------------------------------- build */

/**
 * Build the pack for one proposal.
 *   api      the page's API caller (staff-ui.js apiFor)
 *   step     (text, done, total) => void, for the progress shown to staff
 * Returns { blob, name, checks, bad }.
 */
export async function buildPack({ proposalId, api, step = () => {}, brand = '', services = {} }) {
  step('Asking for the record…');
  const r = await api('POST', '/api/archive', { action: 'pack', proposal: proposalId });
  if (!r.ok || !r.json || !r.json.pack) throw Object.assign(new Error('pack'), { userMessage: (r.json && r.json.error) || 'The record could not be fetched. Try again.' });
  const pack = r.json.pack;
  const files = [];
  const checks = [];
  const add = (path, bytes, what, recorded) => {
    const data = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
    files.push({ name: path, bytes: data, what, recorded: recorded || null });
    return data;
  };
  const check = async (path, data, recorded, what) => {
    const sha = await sha256Hex(data);
    const c = { path, what, sha256: sha, recorded: recorded || null, matches: recorded ? sha === recorded : null };
    checks.push(c);
    return c;
  };
  const inlined = new Map();
  const docByHash = new Map();
  const ref = slugOf(pack.proposal.reference || pack.proposal.project || 'proposal', 40);
  const total = pack.revisions.length * 2 + pack.revisions.reduce((n, v) => n + v.documents.length, 0) + pack.acceptances.length;
  let done = 0;
  const tick = (text) => step(text, (done += 1), total);

  const revisions = [];
  for (const rev of pack.revisions) {
    const dir = `revisions/rev-${slugOf(rev.rev, 8)}`;
    const published = add(`${dir}/published.json`, rev.published, `Revision ${rev.rev}: published text`, rev.plaintextSha256);
    const revCheck = await check(`${dir}/published.json`, published, rev.plaintextSha256, `Revision ${rev.rev} published text`);
    tick(`Revision ${rev.rev}: published text checked`);
    const docFiles = new Map();
    const documents = [];
    for (const doc of rev.documents) {
      let file = docByHash.get(doc.sha256);
      let c;
      if (file) {
        c = checks.find((x) => x.path === file);
      } else {
        try {
          const link = await api('POST', '/api/archive', { action: 'file', revision: rev.id, card: doc.card });
          if (!link.ok || !link.json || !link.json.url) throw new Error((link.json && link.json.error) || 'no link');
          const bytes = await bytesOf(link.json.url, { credentials: 'omit' });
          file = `documents/${slugOf(String(doc.name || doc.title).replace(/\.pdf$/i, ''), 50)}-${String(doc.sha256).slice(0, 12)}.pdf`;
          add(file, bytes, `Document: ${doc.title || doc.name}`, doc.sha256);
          c = await check(file, bytes, doc.sha256, `Document ${doc.title || doc.name}`);
          docByHash.set(doc.sha256, file);
        } catch (err) {
          c = { path: null, what: `Document ${doc.title || doc.name} (revision ${rev.rev})`, recorded: doc.sha256, matches: null, error: 'could not be fetched' };
          checks.push(c);
        }
      }
      if (file) docFiles.set(doc.card, file);
      documents.push({ ...doc, file, check: c });
      tick(`Revision ${rev.rev}: ${doc.title || doc.name}`);
    }
    let readable = null;
    try {
      const html = await readableCopy(rev, docFiles, inlined);
      add(`${dir}/readable.html`, html, `Revision ${rev.rev}: readable copy`);
      readable = `${dir}/readable.html`;
    } catch {
      checks.push({ path: `${dir}/readable.html`, what: `Revision ${rev.rev} readable copy`, recorded: null, matches: null, error: 'could not be drawn' });
    }
    tick(`Revision ${rev.rev}: readable copy drawn`);
    revisions.push({ ...rev, published: `${dir}/published.json`, readable, documents, check: revCheck });
  }

  const acceptances = [];
  for (const a of pack.acceptances) {
    const path = `acceptances/rev-${slugOf(a.rev || 'x', 8)}${a.kind === 'staff' ? '-recorded-by-staff' : ''}.html`;
    let c;
    try {
      const bytes = await bytesOf(`/staff/acceptance/${encodeURIComponent(a.id)}`, { credentials: 'same-origin' });
      add(path, bytes, `Acceptance record, revision ${a.rev}`, a.record_sha256);
      c = await check(path, bytes, a.record_sha256, `Acceptance record, revision ${a.rev}`);
    } catch (err) {
      c = { path, what: `Acceptance record, revision ${a.rev}`, recorded: a.record_sha256, matches: null, error: err.status === 409 ? 'the stored record does not match its fingerprint' : 'could not be fetched' };
      checks.push(c);
    }
    acceptances.push({ ...a, file: c.matches === null ? null : path, check: c });
    tick(`Acceptance of revision ${a.rev} checked`);
  }

  step('Writing the history and the cover…');
  const history = historyRows(pack);
  add('history.csv', csvText(history), 'History, for a spreadsheet');
  add('history.json', JSON.stringify({ events: pack.events, views: pack.views, staffAudit: pack.audit }, null, 2), 'History, as recorded');

  const generatedAt = new Date().toISOString();
  // The cover's colours are the system's own tokens, carried inside it.
  const tokensCss = new TextDecoder().decode(await bytesOf('/assets/css/tokens.css')).replace(/@font-face\s*\{[^}]*\}/g, '').replace(/<\/style/gi, '');
  const meta = {
    brand, services, tokensCss, proposal: pack.proposal, retention: pack.retention, revisions, acceptances,
    checks, historyCount: history.length - 1, generatedAt, generatedBy: r.json.by,
  };
  add('index.html', coverHtml(meta), 'Cover and index');
  // Every file's fingerprint, then the manifest (which lists them all, and every check).
  const listed = [];
  for (const f of files) listed.push({ path: f.name, bytes: f.bytes.length, sha256: await sha256Hex(f.bytes), what: f.what, recordedSha256: f.recorded, matchesRecorded: f.recorded ? (checks.find((c) => c.path === f.name) || {}).matches === true : null });
  const manifest = {
    pack: 'proposal record pack', version: 1, generatedAt, generatedBy: r.json.by,
    proposal: { id: pack.proposal.id, reference: pack.proposal.reference, project: pack.proposal.project, client: pack.proposal.client_company },
    retention: pack.retention,
    summary: { files: listed.length, fingerprintsChecked: checks.length, matching: checks.filter((c) => c.matches === true).length, problems: checks.filter((c) => c.matches !== true).map((c) => ({ what: c.what, path: c.path, problem: c.matches === false ? 'does not match' : c.error })) },
    files: listed,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const sums = listed.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n';
  const folder = `${ref}-record-pack`;
  const zipFiles = [
    { name: `${folder}/index.html`, bytes: files.find((f) => f.name === 'index.html').bytes },
    { name: `${folder}/manifest.json`, bytes: enc.encode(manifestText) },
    { name: `${folder}/SHA256SUMS`, bytes: enc.encode(sums) },
    ...files.filter((f) => f.name !== 'index.html').map((f) => ({ name: `${folder}/${f.name}`, bytes: f.bytes })),
  ];
  step('Packing…');
  const blob = makeZip(zipFiles);
  const bad = checks.filter((c) => c.matches !== true);
  return { blob, name: `${folder}.zip`, checks, bad };
}

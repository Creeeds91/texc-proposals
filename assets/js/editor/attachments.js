/**
 * Documents in the editor: attach a PDF to a card, see what the check found,
 * preview it exactly as a client would.
 *
 *   - the browser hashes the file, the server fixes where it goes, and the
 *     bytes go straight to the private bucket (a PDF can be larger than a
 *     function accepts); then the server reads them back and checks them
 *     (lib/attachments.js)
 *   - the verdict sits on the card: passed; refused, and why; or could not be
 *     verified. An administrator may release the last two with a reason,
 *     which is recorded. A file that is not a PDF, is encrypted or is a "zip
 *     bomb" is never kept at all.
 *   - Preview opens the same viewer a client gets (assets/js/pdf-viewer.js)
 */
import { h, icon } from './dom.js';
import { api } from './api.js';

const MAX = 25 * 1024 * 1024;
const files = new Map();
let loaded = false;

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The files on this proposal, from the server. */
export async function loadFiles(proposalId) {
  if (!proposalId) return false;
  const r = await api('POST', '/api/attachments', { action: 'list', proposal: proposalId });
  if (!r.ok) return false;
  files.clear();
  for (const f of r.json.files || []) files.set(f.id, f);
  loaded = true;
  return true;
}

/** The checklist's view of them; undefined until loaded, so nothing is judged on a guess. */
export const filesContext = () => (loaded ? Object.fromEntries([...files].map(([id, f]) => [id, { status: f.status }])) : undefined);

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PUT the bytes to the one-off upload URL, with progress. Resolves true when stored (or already there). */
function put(url, buf, onProgress) {
  return new Promise((done) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Type', 'application/pdf');
    x.setRequestHeader('x-upsert', 'false');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onload = () => done(x.status < 300 || /Duplicate|already exists/i.test(x.responseText || ''));
    x.onerror = () => done(false);
    x.send(buf);
  });
}

class AttachError extends Error {
  constructor(message, finding) { super(message); this.finding = finding; }
}

/** Upload, check, and record one file. Resolves the file's record; throws AttachError. */
export async function attachFile(proposalId, file, onStage) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new AttachError('Only PDF files can be attached.');
  if (file.size > MAX) throw new AttachError('That file is larger than 25 MB.');
  const name = /\.pdf$/i.test(file.name) ? file.name : `${file.name}.pdf`;
  onStage('Reading the file…');
  const buf = await file.arrayBuffer();
  const sha = await sha256Hex(buf);
  const begin = await api('POST', '/api/attachments', { action: 'begin', proposal: proposalId, name, bytes: file.size, sha256: sha });
  if (!begin.ok) throw new AttachError((begin.json && begin.json.error) || 'The upload could not be started.');
  if (begin.json.file) { files.set(begin.json.file.id, begin.json.file); return begin.json.file; }
  onStage(`Uploading… 0 of ${kb(file.size)}`, 0);
  const stored = await put(begin.json.uploadUrl, buf, (n, total) => onStage(`Uploading… ${kb(n)} of ${kb(total)}`, n / total));
  if (!stored) throw new AttachError('The upload did not complete. Check the connection and try again.');
  onStage('Checking the file…');
  const v = await api('POST', '/api/attachments', { action: 'verify', proposal: proposalId, name, sha256: sha });
  if (!v.ok) throw new AttachError((v.json && v.json.error) || 'The file could not be checked.', v.json && v.json.finding);
  files.set(v.json.file.id, v.json.file);
  return v.json.file;
}

/** A 60-second link to one file, for the preview. */
export async function staffLink(proposalId, fileId, { download = false } = {}) {
  const r = await api('POST', '/api/attachments', { action: 'url', proposal: proposalId, id: fileId, download });
  if (!r.ok) throw Object.assign(new Error('link'), { userMessage: (r.json && r.json.error) || 'The file could not be opened.' });
  return r.json;
}

/** The editor's hook for the page's View and Download buttons. */
export function previewHook(ctx) {
  return (cardId, opts) => {
    const card = (ctx.cfg().attachments || []).find((a) => a && a.id === cardId);
    if (!card || !card.file) return Promise.reject(Object.assign(new Error('none'), { userMessage: 'No file is attached to this document yet. Attach one in the editor.' }));
    return staffLink(ctx.proposalId(), card.file, opts);
  };
}

const VERDICT = {
  clean: ['check-circle', 'Passed the check'],
  override: ['shield-check', 'Released by an administrator'],
  rejected: ['alert-triangle', 'Refused by the check'],
  'cannot-verify': ['alert-circle', 'Could not be verified'],
  pending: ['clock', 'Not checked yet'],
};

/** The box on each document card in the Documents panel. */
export function attachBox(ctx, row, rowPath) {
  const pid = ctx.proposalId();
  const f = row.file ? files.get(row.file) : null;
  const box = h('div', { class: 'ed-attach', dataset: { path: [...rowPath, 'file'].join('.') } });
  const status = h('div', { class: 'ed-attach-status', role: 'status' });
  const tools = h('div', { class: 'ed-attach-tools' });
  const bar = h('progress', { class: 'ed-attach-progress', max: '1', value: '0', hidden: true });
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'ed-file', 'aria-label': `Choose a PDF for ${row.title || 'this document'}` });
  box.append(status, bar, tools, input);

  const say = (state, ico, title, ...lines) => {
    box.dataset.state = state;
    status.replaceChildren(h('p', { class: 'ed-attach-verdict' }, icon(ico), h('span', { text: title })), ...lines.filter(Boolean).map((l) => (typeof l === 'string' ? h('p', { class: 'ed-hint', text: l }) : l)));
  };
  const write = (patch) => ctx.set(rowPath, { ...ctx.get(rowPath), ...patch }, { structural: true });

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    tools.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    bar.hidden = false;
    try {
      const got = await attachFile(pid, file, (text, frac) => {
        say('busy', 'upload', text);
        if (typeof frac === 'number') bar.value = frac; else bar.removeAttribute('value');
      });
      const title = (ctx.get([...rowPath, 'title']) || '').trim();
      write({ file: got.id, pages: got.pages || undefined, bytes: got.bytes || undefined, ...(title ? {} : { title: got.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() }) });
      ctx.toast(got.status === 'clean' ? `${got.name} attached. It passed the check.` : `${got.name} was stored, but did not pass the check.`);
    } catch (e) {
      bar.hidden = true;
      tools.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      const reasons = (e.finding && e.finding.reasons) || [];
      say('error', 'alert-triangle', e.message || 'That file could not be attached.', ...reasons, reasons.length ? 'Nothing was kept.' : null);
    }
  });
  const choose = (label) => h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => input.click() }, icon('upload'), h('span', { text: label }));

  if (!pid) {
    say('none', 'file-text', 'Files can be attached once the proposal is saved.');
    return box;
  }
  if (!row.file) {
    say('none', 'file-text', row.visibility === 'on-request' ? 'No file (listed as available on request)' : 'No file attached yet',
      row.visibility === 'on-request' ? null : 'A client can open this document, so it needs a PDF.');
    tools.append(choose('Attach a PDF'));
    return box;
  }
  if (!loaded) { say('busy', 'clock', 'Loading the file’s check result…'); return box; }
  if (!f) {
    say('error', 'alert-triangle', 'Its file is no longer on this proposal', 'Attach it again.');
    tools.append(choose('Attach a PDF'), h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => write({ file: undefined, pages: undefined, bytes: undefined }) }, h('span', { text: 'Clear' })));
    return box;
  }
  const [ico, title] = VERDICT[f.status] || VERDICT.pending;
  const facts = [f.pages ? `${f.pages} ${f.pages === 1 ? 'page' : 'pages'}` : '', kb(f.bytes), f.name].filter(Boolean).join(' · ');
  const extra = [];
  if (f.status === 'override') extra.push(`${f.overrideBy}: “${f.overrideReason}”`);
  if (f.status === 'rejected' || f.status === 'cannot-verify') {
    extra.push(...f.reasons);
    extra.push(row.visibility === 'client'
      ? `It cannot go to the client like this. Attach a flattened copy (open it and print it to PDF) — ${ctx.BRAND.name}'s own suite PDFs carry calculation scripts and always need one. ${f.overridable ? 'Or an administrator can release it, with a reason.' : ''}`.trim()
      : 'It is listed as available on request, so it is not sent.');
  }
  say(f.status, ico, title, facts, ...extra);
  tools.append(
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
      const viewer = await import('../pdf-viewer.js');
      viewer.openViewer({ title: row.title || f.name, meta: facts, link: (o) => staffLink(pid, f.id, o) });
    } }, icon('eye'), h('span', { text: 'Preview' })),
    choose('Replace'),
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => {
      write({ file: undefined, pages: undefined, bytes: undefined });
      ctx.toast(`File removed from “${row.title || 'the document'}”`, () => write({ file: f.id, pages: f.pages || undefined, bytes: f.bytes || undefined }));
    } }, h('span', { text: 'Remove file' })));
  if ((f.status === 'rejected' || f.status === 'cannot-verify') && f.overridable && ctx.isAdmin()) {
    tools.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm ed-attach-release', onclick: async () => {
      const reason = window.prompt(`Release “${f.name}” to be sent as it is?\n\nThe check found: ${f.reasons.join(' ')}\n\nSay why it is safe to send (it is recorded with your name):`);
      if (reason === null) return;
      const r = await api('POST', '/api/attachments', { action: 'override', proposal: pid, id: f.id, reason });
      if (!r.ok) { ctx.toast((r.json && r.json.error) || 'It could not be released.'); return; }
      files.set(f.id, r.json.file);
      ctx.refresh();
      ctx.toast('Released. The checklist will point it out before publishing.');
    } }, icon('shield-check'), h('span', { text: 'Release…' })));
  }
  return box;
}

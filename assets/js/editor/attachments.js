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
 *   - or a card offers a document from the library (Phase 8, api/library.js):
 *     publishing sends its current approved file, with the library's code,
 *     revision, date and expiry
 *   - several PDFs dropped on the panel become a card each; one dropped on a
 *     card attaches to it
 */
import { h, icon } from './dom.js';
import { api } from './api.js';
import { kb, pdfProblem, pdfName, sha256Hex, putFile } from '../upload.js';
import { standing, ownerName, evidenceFromList } from '../library-view.js';

const files = new Map();
let loaded = false;
const library = { items: [], people: [], kinds: [], today: '', loaded: false };
const PER_PROPOSAL = 20;
/** The last batch of PDFs dropped at once, line by line: kept here because the drawer redraws as each card is saved. */
const dropLog = [];

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

/** The document library, from the server. */
export async function loadLibrary() {
  const r = await api('POST', '/api/library', { action: 'list' });
  if (!r.ok) return false;
  Object.assign(library, { items: r.json.items || [], people: r.json.people || [], kinds: r.json.kinds || [], today: r.json.today || '', loaded: true });
  return true;
}

/** The checklist's view of the library; undefined until loaded. */
export const evidenceContext = () => (library.loaded ? evidenceFromList(library.items) : undefined);

const libraryItem = (id) => library.items.find((i) => i.id === id) || null;

/**
 * The preview shows a library card as publishing will send it: the library's
 * code, revision, date and expiry, and its current file's size. Never changes
 * the draft itself.
 */
export function withLibrary(cfg) {
  if (!library.loaded || !Array.isArray(cfg && cfg.attachments) || !cfg.attachments.some((a) => a && a.evidence)) return cfg;
  return { ...cfg, attachments: cfg.attachments.map((a) => {
    const item = a && a.evidence ? libraryItem(a.evidence) : null;
    const cur = item && item.current;
    if (!cur) return a;
    return { ...a, docCode: item.docCode || undefined, docRev: cur.docRev || undefined, docDate: cur.docDate || undefined, expiresOn: cur.expiresOn || undefined, pages: cur.pages || undefined, bytes: cur.bytes || undefined };
  }) };
}
const kindName = (k) => (library.kinds.find(([x]) => x === k) || [k, k])[1];
/** Where a library document goes on the client's page, until staff choose otherwise. */
const GROUP_OF_KIND = { insurance: 'certificates', compliance: 'certificates', procedure: 'risk', project: 'project', ssds: 'other' };

/** A 60-second link to a library document's current file. */
async function libraryLink(item, { download = false } = {}) {
  if (!item || !item.current) throw Object.assign(new Error('none'), { userMessage: 'This library document has no approved file yet.' });
  const r = await api('POST', '/api/library', { action: 'url', id: item.id, version: item.current.id, download });
  if (!r.ok) throw Object.assign(new Error('link'), { userMessage: (r.json && r.json.error) || 'The file could not be opened.' });
  return r.json;
}

class AttachError extends Error {
  constructor(message, finding) { super(message); this.finding = finding; }
}

/** Upload, check, and record one file. Resolves the file's record; throws AttachError. */
export async function attachFile(proposalId, file, onStage) {
  const problem = pdfProblem(file);
  if (problem) throw new AttachError(problem);
  const name = pdfName(file);
  onStage('Reading the file…');
  const buf = await file.arrayBuffer();
  const sha = await sha256Hex(buf);
  const begin = await api('POST', '/api/attachments', { action: 'begin', proposal: proposalId, name, bytes: file.size, sha256: sha });
  if (!begin.ok) throw new AttachError((begin.json && begin.json.error) || 'The upload could not be started.');
  if (begin.json.file) { files.set(begin.json.file.id, begin.json.file); return begin.json.file; }
  onStage(`Uploading… 0 of ${kb(file.size)}`, 0);
  const stored = await putFile(begin.json.uploadUrl, buf, (n, total) => onStage(`Uploading… ${kb(n)} of ${kb(total)}`, n / total));
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
    if (card && card.evidence) return libraryLink(libraryItem(card.evidence), opts);
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
  if (row.evidence) return libraryBox(ctx, row, rowPath);
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

  const take = async (file) => {
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
  };
  input.addEventListener('change', () => { const file = input.files && input.files[0]; input.value = ''; if (file) take(file); });
  if (pid) dropTarget(box, (list) => take(list[0]), ctx.toast);
  const choose = (label) => h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => input.click() }, icon('upload'), h('span', { text: label }));
  const fromLibrary = () => h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => chooseFromLibrary(ctx, rowPath) }, icon('file-check'), h('span', { text: 'Choose from the library' }));

  if (!pid) {
    say('none', 'file-text', 'Files can be attached once the proposal is saved.');
    return box;
  }
  if (!row.file) {
    say('none', 'file-text', row.visibility === 'on-request' ? 'No file (listed as available on request)' : 'No file attached yet',
      row.visibility === 'on-request' ? null : 'A client can open this document, so it needs a PDF.');
    tools.append(choose('Attach a PDF'), fromLibrary());
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
    const release = f.overridable ? ' Or an administrator can release it, with a reason.' : '';
    if (row.visibility !== 'client') extra.push('It is listed as available on request, so it is not sent.');
    else if (f.status === 'rejected') extra.push(`It cannot go to the client like this. Attach a flattened copy (open it and print it to PDF) — ${ctx.BRAND.name}'s own suite PDFs carry calculation scripts and always need one.${release}`);
    else extra.push(`It cannot go to the client unchecked. Try a fresh copy (open it and print it to PDF).${release}`);
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

/* -------------------------------------------------------------- the library */

/** Drop PDFs on an element; `onFiles` gets the PDFs dropped (others are named and left out). */
function dropTarget(el, onFiles, toast) {
  // Files only, and they stop here: the drawer's own drag and drop moves panels.
  const files = (e) => [...(e.dataTransfer.types || [])].includes('Files');
  el.addEventListener('dragover', (e) => { if (files(e)) { e.preventDefault(); e.stopPropagation(); el.classList.add('is-over'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('is-over'); });
  el.addEventListener('drop', (e) => {
    if (!files(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('is-over');
    const list = [...(e.dataTransfer.files || [])];
    const pdfs = list.filter((f) => !pdfProblem(f) || pdfProblem(f) === 'That file is larger than 25 MB.');
    if (toast && pdfs.length < list.length) toast(`Only PDFs can be attached; ${list.length - pdfs.length} other ${list.length - pdfs.length === 1 ? 'file was' : 'files were'} left out.`);
    if (pdfs.length) onFiles(pdfs);
  });
}

/** A card that offers a library document: what it is, how it stands, and what the client will get. */
function libraryBox(ctx, row, rowPath) {
  const box = h('div', { class: 'ed-attach ed-attach--library', dataset: { path: [...rowPath, 'evidence'].join('.') } });
  const write = (patch) => ctx.set(rowPath, { ...ctx.get(rowPath), ...patch }, { structural: true });
  const item = libraryItem(row.evidence);
  const tools = h('div', { class: 'ed-attach-tools' });
  const line = (ico, text) => h('p', { class: 'ed-attach-verdict' }, icon(ico), h('span', { text }));
  if (!library.loaded) { box.dataset.state = 'busy'; box.append(line('clock', 'Loading the library…')); return box; }
  if (!item) {
    box.dataset.state = 'error';
    box.append(line('alert-triangle', 'Its library document is no longer in the library'), h('p', { class: 'ed-hint', text: 'Choose another, or attach a PDF.' }));
  } else {
    const st = standing(item, library.today);
    const cur = item.current;
    box.dataset.state = st.key === 'current' ? 'clean' : (st.key === 'expiring' ? 'override' : 'error');
    box.append(
      h('p', { class: 'ed-attach-kicker', text: 'From the library' }),
      line(st.key === 'current' ? 'check-circle' : 'alert-triangle', `${item.title}: ${st.text}`),
      h('p', { class: 'ed-hint', text: [ownerName(item, library.people, ctx.BRAND.legalName || ctx.BRAND.name), kindName(item.kind), cur && cur.docRev ? `Rev ${cur.docRev}` : '', cur && cur.pages ? `${cur.pages} ${cur.pages === 1 ? 'page' : 'pages'}` : '', cur ? kb(cur.bytes) : ''].filter(Boolean).join(' · ') }),
      h('p', { class: 'ed-hint', text: 'Its code, revision, date and expiry come from the library. Publishing sends its current approved file; a renewal approved on the Documents page goes out with the next revision, and one already sent keeps its own.' }));
    if (cur) tools.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
      const viewer = await import('../pdf-viewer.js');
      viewer.openViewer({ title: row.title || item.title, meta: [cur.docRev ? `Rev ${cur.docRev}` : '', kb(cur.bytes)].filter(Boolean).join(' · '), link: (o) => libraryLink(item, o) });
    } }, icon('eye'), h('span', { text: 'Preview' })));
  }
  tools.append(
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => chooseFromLibrary(ctx, rowPath) }, icon('file-check'), h('span', { text: 'Change' })),
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => {
      const was = row.evidence;
      write({ evidence: undefined, pages: undefined, bytes: undefined });
      ctx.toast(`“${row.title || 'The document'}” no longer offers the library document`, () => write({ evidence: was }));
    } }, h('span', { text: 'Use a PDF instead' })));
  box.append(tools);
  return box;
}

/** The library, to choose a document for one card. */
function chooseFromLibrary(ctx, rowPath) {
  const dlg = h('dialog', { class: 'ed-dialog ed-dialog--wide', 'aria-label': 'Choose from the library' });
  const search = h('input', { type: 'search', class: 'ed-input', placeholder: 'Title, issuer, number, code', 'aria-label': 'Search the library', autocomplete: 'off' });
  const list = h('div', { class: 'ed-libpick' });
  const draw = () => {
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const live = library.items.filter((i) => !i.retiredAt)
      .filter((i) => q.every((w) => [i.title, i.issuer, i.number, i.docCode, kindName(i.kind)].join(' ').toLowerCase().includes(w)));
    list.replaceChildren(...(live.length ? live.map((i) => {
      const st = standing(i, library.today);
      const usable = !!i.current && st.key !== 'expired';
      return h('button', { type: 'button', class: 'ed-libpick-item', disabled: !usable, onclick: () => {
        const card = ctx.get(rowPath) || {};
        const cur = i.current;
        ctx.set(rowPath, { ...card, evidence: i.id, file: undefined, pages: cur.pages || undefined, bytes: cur.bytes || undefined,
          title: (card.title || '').trim() ? card.title : i.title,
          category: card.category && card.category !== 'project' ? card.category : (GROUP_OF_KIND[i.kind] || 'other') }, { structural: true });
        dlg.close();
        ctx.toast(`“${i.title}” from the library.`);
      } },
      h('span', { class: 'ed-proposal-name', text: i.title }),
      h('span', { class: 'ed-proposal-meta', text: [ownerName(i, library.people, ctx.BRAND.legalName || ctx.BRAND.name), kindName(i.kind), i.docCode].filter(Boolean).join(' · ') }),
      h('span', { class: `ed-libpick-state ed-libpick-state--${st.key}`, text: usable ? st.text : (st.key === 'expired' ? `${st.text}. Approve the renewal in Documents first.` : `${st.text}. Approve a file in Documents first.`) }));
    }) : [h('p', { class: 'ed-hint', text: library.items.length ? 'Nothing in the library matches.' : 'The library is empty. An administrator adds documents on the Documents page.' })]));
  };
  search.addEventListener('input', draw);
  dlg.append(
    h('div', { class: 'ed-dialog-head' }, h('h2', { text: 'Choose from the library' }), h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    h('p', { class: 'ed-hint', text: 'Standing documents, uploaded once on the Documents page. The card sends the current approved file of the one you choose.' }),
    search, list,
    h('div', { class: 'ed-dialog-foot' }, h('a', { class: 'btn btn--secondary btn--sm', href: '/documents', target: '_blank', rel: 'noopener' }, icon('external-link'), h('span', { text: 'Open the Documents page' }))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  draw();
  dlg.showModal();
  // Fresh each time: a document may have been approved in another tab since the editor opened.
  loadLibrary().then(draw);
}

/**
 * Several PDFs at once: each becomes a card the client can open, titled from
 * its file name, and goes up in turn with its own progress.
 */
export function dropZone(ctx) {
  const pid = ctx.proposalId();
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, class: 'ed-file', 'aria-label': 'Choose several PDFs' });
  const progress = h('ul', { class: 'ed-drop-list', 'aria-live': 'polite' }, dropLog.map((x) => h('li', { dataset: { drop: x.id }, text: x.text })));
  const say = (entry, text) => {
    entry.text = text;
    const li = document.querySelector(`.ed-drop-list [data-drop="${entry.id}"]`);
    if (li) li.textContent = text;
  };
  const zone = h('div', { class: 'ed-drop' },
    h('p', { class: 'ed-drop-text' }, icon('upload'), h('span', { text: 'Drop several PDFs here to add a document for each, or ' }),
      h('button', { type: 'button', class: 'ed-linkbtn', disabled: !pid, onclick: () => input.click() }, 'choose them'), h('span', { text: '.' })),
    input, progress);
  if (!pid) { zone.append(h('p', { class: 'ed-hint', text: 'Files can be attached once the proposal is saved.' })); return zone; }
  const addAll = async (list) => {
    const room = PER_PROPOSAL - (ctx.get(['attachments']) || []).filter((a) => a && a.file).length;
    const take = list.slice(0, Math.max(0, room));
    if (take.length < list.length) ctx.toast(`A proposal can carry up to ${PER_PROPOSAL} files; ${list.length - take.length} were left out.`);
    const stamp = Date.now().toString(36);
    const cards = take.map((f, i) => ({ id: `a${stamp}${i}`, category: 'project', visibility: 'client', title: pdfName(f).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() }));
    dropLog.splice(0, dropLog.length, ...cards.map((c) => ({ id: c.id, text: `${c.title}: waiting…` })));
    ctx.set(['attachments'], [...(ctx.get(['attachments']) || []), ...cards], { structural: true });
    for (let i = 0; i < take.length; i += 1) {
      const entry = dropLog[i];
      try {
        const got = await attachFile(pid, take[i], (text) => say(entry, `${cards[i].title}: ${text}`));
        const now = ctx.get(['attachments']) || [];
        const at = now.findIndex((c) => c && c.id === cards[i].id);
        say(entry, `${cards[i].title}: ${got.status === 'clean' ? 'attached, and it passed the check' : 'stored, but it did not pass the check'}`);
        if (at >= 0) ctx.set(['attachments', at], { ...now[at], file: got.id, pages: got.pages || undefined, bytes: got.bytes || undefined }, { structural: true });
      } catch (e) {
        say(entry, `${cards[i].title}: ${e.message || 'it could not be attached'}`);
      }
    }
    ctx.toast(`${take.length} ${take.length === 1 ? 'document' : 'documents'} added. Check each card's title and group.`);
  };
  input.addEventListener('change', () => { const list = [...(input.files || [])]; input.value = ''; if (list.length) addAll(list); });
  dropTarget(zone, addAll, ctx.toast);
  return zone;
}

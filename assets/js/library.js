/**
 * The Documents page (templates/library.html, served behind sign-in by
 * api/documents.js): the library of standing documents, what needs attention
 * in it, and one document's files — the current one, a renewal waiting for
 * approval, and the earlier ones revisions already sent.
 *
 * Everyone signed in can look and preview. Only an administrator adds,
 * uploads, approves, releases or retires; api/library.js holds every rule
 * again. Nothing from the data is ever written as HTML.
 */
import { h, icon, apiFor } from './staff-ui.js';
import { standing, renewalWaiting, ownerName, dayAu } from './library-view.js';
import { kb, pdfProblem, pdfName, sha256Hex, putFile } from './upload.js';

const D = document;
const $ = (id) => D.getElementById(id);
const api = apiFor('/documents');
const BRAND = JSON.parse($('brand-data').textContent);
const RANK = { viewer: 1, editor: 2, admin: 3, super: 4 };
const state = { who: null, items: [], people: [], kinds: [], currencies: [], today: '', f: { q: '', owner: '', kind: '', show: 'live' } };
const can = (role) => (RANK[state.who && state.who.role] || 0) >= RANK[role];
const kindName = (k) => (state.kinds.find(([x]) => x === k) || [k, k])[1];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'short', year: 'numeric' });
const when = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
const whose = (item) => ownerName(item, state.people, BRAND.legalName || BRAND.name);

let toastTimer = null;
let toastEl = null;
function toast(text) {
  toastEl = toastEl || $('db-toast');
  const panel = $('db-panel');
  (panel.open ? panel : D.body).append(toastEl);
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

const VERDICT = {
  clean: ['check-circle', 'Passed the check'],
  override: ['shield-check', 'Released by an administrator'],
  rejected: ['alert-triangle', 'Refused by the check'],
  'cannot-verify': ['alert-circle', 'Could not be verified'],
  pending: ['clock', 'Not checked yet'],
};

/* ------------------------------------------------------------------ the list */

function chip(st) {
  return h('span', { class: `lib-chip lib-chip--${st.key}` }, icon(st.key === 'current' ? 'check-circle' : st.key === 'retired' ? 'archive' : 'alert-triangle'), h('span', { text: st.text }));
}

function matches(item) {
  const f = state.f;
  if (f.show === 'live' && item.retiredAt) return false;
  if (f.show === 'retired' && !item.retiredAt) return false;
  if (f.owner && (item.ownerKind === 'organisation' ? 'org' : item.ownerRef) !== f.owner) return false;
  if (f.kind && item.kind !== f.kind) return false;
  if (f.q) {
    const hay = [item.title, item.issuer, item.number, item.docCode, whose(item), kindName(item.kind)].join(' ').toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function renderAttention() {
  const rows = state.items.map((i) => ({ i, st: standing(i, state.today) }))
    .filter(({ i, st }) => st.urgent || renewalWaiting(i))
    .sort((a, b) => ['expired', 'refused', 'awaiting', 'none', 'expiring', 'current'].indexOf(a.st.key) - ['expired', 'refused', 'awaiting', 'none', 'expiring', 'current'].indexOf(b.st.key));
  $('lib-attention-count').textContent = rows.length ? String(rows.length) : '';
  $('lib-attention-list').replaceChildren(...(rows.length ? rows.map(({ i, st }) => h('li', {},
    h('button', { type: 'button', class: 'db-follow-item', onclick: () => openItem(i.id) },
      h('span', { class: 'db-follow-title', text: i.title }),
      h('span', { class: 'db-follow-client', text: `${whose(i)} · ${kindName(i.kind)}` }),
      st.urgent ? h('span', { class: 'db-flag' }, icon('flag'), h('span', { text: st.text })) : null,
      renewalWaiting(i) ? h('span', { class: 'db-flag' }, icon('clock'), h('span', { text: 'A renewed file is waiting for approval' })) : null))) : [h('li', { class: 'db-follow-none' }, icon('check-circle'), h('span', { text: 'Nothing needs attention: every document has a current, approved file.' }))]));
}

function itemRow(i) {
  const st = standing(i, state.today);
  const cur = i.current;
  const facts = [kindName(i.kind), i.docCode, cur && cur.docRev ? `Rev ${cur.docRev}` : '', i.issuer, i.number ? `No. ${i.number}` : ''].filter(Boolean).join(' · ');
  const used = i.usage.revisions ? `Sent in ${plural(i.usage.revisions, 'revision')} of ${plural(i.usage.proposals, 'proposal')}` : 'Not sent yet';
  return h('li', { class: 'lib-item' },
    h('div', { class: 'lib-item-main' },
      h('button', { type: 'button', class: 'lib-item-title', onclick: () => openItem(i.id) }, i.title),
      h('p', { class: 'lib-item-facts', text: facts }),
      h('p', { class: 'lib-item-used', text: `${used}${i.usage.drafts ? ` · offered on ${plural(i.usage.drafts, 'draft')}` : ''}` })),
    h('div', { class: 'lib-item-state' }, chip(st), renewalWaiting(i) ? h('span', { class: 'lib-chip lib-chip--awaiting' }, icon('clock'), h('span', { text: 'Renewal waiting' })) : null));
}

function renderList() {
  const shown = state.items.filter(matches);
  $('lib-count').textContent = `${plural(shown.length, 'document')}`;
  const groups = new Map([['org', []], ...state.people.map((p) => [p.slug, []])]);
  for (const i of shown) {
    const key = i.ownerKind === 'organisation' ? 'org' : i.ownerRef;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  $('lib-groups').replaceChildren(...[...groups].filter(([, list]) => list.length).map(([key, list]) => h('section', { class: 'lib-group', 'aria-labelledby': `lib-g-${key}` },
    h('h3', { class: 'db-h3', id: `lib-g-${key}`, text: key === 'org' ? `${BRAND.legalName || BRAND.name}: company documents` : `${whose(list[0])}: personal documents` }),
    h('ul', { class: 'lib-items' }, list.map(itemRow)))));
  const empty = $('lib-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = state.items.length ? 'No document matches these filters.' : (can('admin') ? 'The library is empty. Add the first document: a certificate of currency, a licence, a procedure.' : 'The library is empty. An administrator adds documents to it.');
}

function fillSelect(el, options, value) {
  el.replaceChildren(...options.map(([v, label]) => h('option', { value: v, text: label })));
  el.value = value;
}

function renderFilters() {
  fillSelect($('f-owner'), [['', 'Everyone'], ['org', BRAND.legalName || BRAND.name], ...state.people.map((p) => [p.slug, p.name])], state.f.owner);
  fillSelect($('f-kind'), [['', 'All kinds'], ...state.kinds], state.f.kind);
  fillSelect($('f-show'), [['live', 'In use'], ['retired', 'Retired'], ['all', 'Everything']], state.f.show);
}

function renderAll() { renderAttention(); renderList(); }

/* ------------------------------------------------------------------ one document */

function panelHead(title) {
  const panel = $('db-panel');
  return h('div', { class: 'db-panel-head' },
    h('h2', { class: 'db-h3', id: 'db-panel-title', text: title }),
    h('button', { type: 'button', class: 'db-close', 'aria-label': 'Close', onclick: () => panel.close() }, icon('x')));
}

const fact = (label, value) => (value ? [h('dt', { text: label }), h('dd', { text: value })] : null);

async function preview(item, v) {
  const viewer = await import('./pdf-viewer.js');
  const meta = [v.docRev ? `Rev ${v.docRev}` : '', v.pages ? plural(v.pages, 'page') : '', kb(v.bytes)].filter(Boolean).join(' · ');
  viewer.openViewer({ title: item.title, meta, link: async (o) => {
    const r = await api('POST', '/api/library', { action: 'url', id: item.id, version: v.id, download: !!(o && o.download) });
    if (!r.ok) throw Object.assign(new Error('link'), { userMessage: (r.json && r.json.error) || 'The file could not be opened.' });
    return r.json;
  } });
}

function versionFacts(v) {
  const [ico, verdict] = VERDICT[v.status] || VERDICT.pending;
  return h('div', { class: 'lib-version-facts' },
    h('p', { class: `lib-verdict lib-verdict--${v.status}` }, icon(ico), h('span', { text: verdict })),
    h('dl', { class: 'db-facts' },
      fact('File', [v.name, v.pages ? plural(v.pages, 'page') : '', kb(v.bytes)].filter(Boolean).join(' · ')),
      fact('Revision', v.docRev),
      fact('Document date', v.docDate ? dayAu(v.docDate) : ''),
      fact('Issued', v.issuedOn ? dayAu(v.issuedOn) : ''),
      fact('Expires', v.expiresOn ? dayAu(v.expiresOn) : ''),
      fact('Uploaded', `${when(v.createdAt)} by ${v.uploadedBy}`),
      fact('Approved', v.approvedAt ? `${when(v.approvedAt)} by ${v.approvedBy}` : ''),
      fact('Released', v.overrideBy ? `${v.overrideBy}: “${v.overrideReason}”` : '')),
    (v.status === 'rejected' || v.status === 'cannot-verify') && v.reasons.length ? h('ul', { class: 'lib-reasons' }, v.reasons.map((x) => h('li', { text: x }))) : null);
}

function approveForm(item, v) {
  const expires = item.currency === 'expires';
  const msg = h('p', { class: 'db-error', role: 'alert' });
  const input = (id, label, type, value, extra = {}) => h('label', { class: 'db-control' }, h('span', { class: 'db-control-label', text: label }), h('input', { id, type, value: value || '', ...extra }));
  const form = h('form', { class: 'lib-approve', onsubmit: async (e) => {
    e.preventDefault();
    const go = form.querySelector('[type=submit]');
    go.disabled = true;
    const r = await api('POST', '/api/library', { action: 'approve', id: item.id, version: v.id,
      docRev: $(`lib-rev-${v.id}`).value, docDate: $(`lib-date-${v.id}`).value, issuedOn: $(`lib-issued-${v.id}`).value, expiresOn: expires ? $(`lib-expires-${v.id}`).value : '' });
    go.disabled = false;
    if (!r.ok) { msg.textContent = (r.json && r.json.error) || 'It could not be approved.'; return; }
    await reload();
    await openItem(item.id);
    toast(item.current ? 'Approved. Proposals offering it send this file from their next revision; earlier revisions keep the one they sent.' : 'Approved. It can now be chosen on any proposal.');
  } },
  h('h4', { class: 'db-h4', text: item.current ? 'Approve this file to replace the current one' : 'Approve this file' }),
  h('p', { class: 'db-note', text: 'Give its facts as printed on it. Once approved it never changes; a renewal is a new file.' }),
  h('div', { class: 'lib-form-grid' },
    input(`lib-rev-${v.id}`, 'Revision', 'text', v.docRev, { maxlength: '20', autocomplete: 'off' }),
    input(`lib-date-${v.id}`, 'Document date', 'date', v.docDate),
    input(`lib-issued-${v.id}`, 'Issued', 'date', v.issuedOn),
    expires ? input(`lib-expires-${v.id}`, 'Expires', 'date', v.expiresOn, { required: true, min: state.today }) : null),
  msg,
  h('div', { class: 'db-actions' }, h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, icon('check-circle'), h('span', { text: 'Approve and make current' }))));
  return form;
}

async function act(item, payload, done) {
  const r = await api('POST', '/api/library', { id: item.id, ...payload });
  if (!r.ok) { toast((r.json && r.json.error) || 'That did not work. Try again.'); return false; }
  await reload();
  await openItem(item.id);
  if (done) toast(done);
  return true;
}

/** Upload a new file to a document: hashed here, stored straight to the bucket, then checked by the server. */
function uploadBox(item) {
  const status = h('p', { class: 'db-note', role: 'status' });
  const bar = h('progress', { class: 'ed-attach-progress', max: '1', value: '0', hidden: true });
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'lib-file', id: 'lib-file', 'aria-label': `Choose a PDF for ${item.title}` });
  const send = async (file) => {
    const problem = pdfProblem(file);
    if (problem) { status.textContent = problem; return; }
    const name = pdfName(file);
    status.textContent = 'Reading the file…';
    const buf = await file.arrayBuffer();
    const sha = await sha256Hex(buf);
    const begin = await api('POST', '/api/library', { action: 'begin', id: item.id, name, bytes: file.size, sha256: sha });
    if (!begin.ok) { status.textContent = (begin.json && begin.json.error) || 'The upload could not be started.'; return; }
    if (begin.json.uploadUrl) {
      bar.hidden = false;
      const stored = await putFile(begin.json.uploadUrl, buf, (n, total) => { status.textContent = `Uploading… ${kb(n)} of ${kb(total)}`; bar.value = n / total; });
      if (!stored) { bar.hidden = true; status.textContent = 'The upload did not complete. Check the connection and try again.'; return; }
      status.textContent = 'Checking the file…';
      bar.removeAttribute('value');
      const v = await api('POST', '/api/library', { action: 'verify', id: item.id, name, sha256: sha });
      bar.hidden = true;
      if (!v.ok) {
        const reasons = (v.json && v.json.finding && v.json.finding.reasons) || [];
        status.replaceChildren(h('span', { text: `${(v.json && v.json.error) || 'The file could not be checked.'} ${reasons.join(' ')}${reasons.length ? ' Nothing was kept.' : ''}` }));
        return;
      }
    }
    await reload();
    await openItem(item.id);
    toast('Uploaded and checked. Approve it to make it current.');
  };
  input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) send(f); });
  const box = h('div', { class: 'lib-upload' },
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'lib-upload', onclick: () => input.click() }, icon('upload'), h('span', { text: item.current ? 'Upload a renewal or new version' : 'Upload the PDF' })),
    input, bar, status);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('is-over'); });
  box.addEventListener('dragleave', () => box.classList.remove('is-over'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('is-over'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) send(f); });
  return box;
}

async function openItem(id) {
  const panel = $('db-panel');
  const item = state.items.find((x) => x.id === id);
  if (!item) return;
  if (!panel.open) panel.showModal();
  const st = standing(item, state.today);
  const admin = can('admin');
  const waiting = item.versions.filter((v) => !v.approvedAt);
  const earlier = item.versions.filter((v) => v.approvedAt && (!item.current || v.id !== item.current.id));

  const actions = h('div', { class: 'db-actions' });
  if (admin && !item.retiredAt) {
    actions.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => factsForm(item) }, icon('pen-line'), h('span', { text: 'Edit details' })));
    actions.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'lib-retire', onclick: () => {
      const note = item.usage.drafts ? ` It is offered on ${plural(item.usage.drafts, 'draft')}: those cannot be published until it is changed there.` : '';
      if (window.confirm(`Retire “${item.title}”? It will not be offered on new proposals. Revisions that sent it keep it.${note}`)) act(item, { action: 'retire' }, 'Retired. It can be restored at any time.');
    } }, icon('archive'), h('span', { text: 'Retire' })));
  }
  if (admin && item.retiredAt) actions.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => act(item, { action: 'restore' }, 'Restored.') }, icon('rotate-ccw'), h('span', { text: 'Restore' })));
  if (admin && !item.current && !earlier.length && !item.usage.drafts && !item.usage.revisions) {
    actions.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm db-danger', onclick: async () => {
      if (!window.confirm(`Remove “${item.title}” from the library? It has never had an approved file and nothing offers it.`)) return;
      const r = await api('POST', '/api/library', { action: 'remove', id: item.id });
      if (!r.ok) { toast((r.json && r.json.error) || 'It could not be removed.'); return; }
      panel.close();
      await reload();
      toast('Removed.');
    } }, icon('trash-2'), h('span', { text: 'Remove' })));
  }

  const cur = item.current;
  panel.replaceChildren(
    panelHead(item.title),
    h('div', { class: 'db-panel-body' },
      h('p', { class: 'db-panel-sub', text: [whose(item), kindName(item.kind), item.docCode].filter(Boolean).join(' · ') }),
      h('div', { class: 'db-panel-state' }, chip(st)),
      actions.childNodes.length ? actions : null,
      h('h3', { class: 'db-h4', text: 'Current file' }),
      cur ? [versionFacts(cur), h('div', { class: 'db-actions' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => preview(item, cur) }, icon('eye'), h('span', { text: 'Preview' })))]
        : h('p', { class: 'db-note', text: 'None yet. A proposal can offer this document once a file is approved.' }),
      waiting.length ? [h('h3', { class: 'db-h4', text: cur ? 'Waiting to replace it' : 'Waiting for approval' }), ...waiting.map((v) => h('div', { class: 'lib-version' },
        versionFacts(v),
        h('div', { class: 'db-actions' },
          v.status !== 'pending' ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => preview(item, v) }, icon('eye'), h('span', { text: 'Preview' })) : null,
          admin && v.overridable && (v.status === 'rejected' || v.status === 'cannot-verify') ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => {
            const reason = window.prompt(`Release “${v.name}” to be sent as it is?\n\nThe check found: ${v.reasons.join(' ')}\n\nSay why it is safe to send (it is recorded with your name):`);
            if (reason !== null) act(item, { action: 'override', version: v.id, reason }, 'Released. It still needs approving.');
          } }, icon('shield-check'), h('span', { text: 'Release…' })) : null,
          admin ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => act(item, { action: 'discard', version: v.id }, 'Discarded.') }, h('span', { text: 'Discard' })) : null),
        admin && (v.status === 'clean' || v.status === 'override') ? approveForm(item, v) : null))] : null,
      admin && !item.retiredAt ? uploadBox(item) : null,
      h('h3', { class: 'db-h4', text: 'About it' }),
      h('dl', { class: 'db-facts' },
        fact('Whose', whose(item)),
        fact('Kind', kindName(item.kind)),
        fact('Issued by', item.issuer),
        fact('Number', item.number),
        fact('Document code', item.docCode),
        fact('Expires', item.currency === 'expires' ? 'Yes, on a date' : 'No'),
        fact('Used', `${item.usage.revisions ? `Sent in ${plural(item.usage.revisions, 'revision')} of ${plural(item.usage.proposals, 'proposal')}` : 'Not sent yet'}${item.usage.drafts ? `; offered on ${plural(item.usage.drafts, 'draft')}` : ''}`),
        fact('Added', `${when(item.createdAt)} by ${item.createdBy}`),
        fact('Retired', item.retiredAt ? `${when(item.retiredAt)} by ${item.retiredBy}` : '')),
      earlier.length ? [h('h3', { class: 'db-h4', text: 'Earlier files' }), h('p', { class: 'db-note', text: 'Kept for good: a revision that sent one still opens it.' }),
        h('ul', { class: 'lib-earlier' }, earlier.map((v) => h('li', {},
          h('span', { text: [v.docRev ? `Rev ${v.docRev}` : v.name, v.expiresOn ? `was current to ${dayAu(v.expiresOn)}` : '', `approved ${when(v.approvedAt)}`].filter(Boolean).join(' · ') }),
          h('button', { type: 'button', class: 'db-textbtn', onclick: () => preview(item, v) }, 'Preview'))))] : null));
}

/** Add a document, or edit one's details. */
function factsForm(item) {
  const panel = $('db-panel');
  if (!panel.open) panel.showModal();
  const editing = !!item;
  const msg = h('p', { class: 'db-error', role: 'alert' });
  const sel = (id, label, options, value) => h('label', { class: 'db-control' }, h('span', { class: 'db-control-label', text: label }),
    h('select', { id }, options.map(([v, t]) => h('option', { value: v, text: t, selected: v === value }))));
  const txt = (id, label, value, extra = {}) => h('label', { class: 'db-control' }, h('span', { class: 'db-control-label', text: label }), h('input', { id, type: 'text', value: value || '', autocomplete: 'off', ...extra }));
  const owner = editing ? (item.ownerKind === 'organisation' ? 'org' : item.ownerRef) : 'org';
  const form = h('form', { class: 'lib-facts-form', onsubmit: async (e) => {
    e.preventDefault();
    const who = $('lib-f-owner').value;
    const payload = {
      ownerKind: who === 'org' ? 'organisation' : 'person', ownerRef: who === 'org' ? '' : who,
      kind: $('lib-f-kind').value, title: $('lib-f-title').value, issuer: $('lib-f-issuer').value, number: $('lib-f-number').value,
      docCode: $('lib-f-code').value, currency: $('lib-f-currency').value,
    };
    const go = form.querySelector('[type=submit]');
    go.disabled = true;
    const r = await api('POST', '/api/library', editing ? { action: 'update', id: item.id, ...payload } : { action: 'create', ...payload });
    go.disabled = false;
    if (!r.ok) { msg.textContent = (r.json && r.json.error) || 'It could not be saved.'; return; }
    await reload();
    await openItem(r.json.item.id);
    toast(editing ? 'Saved.' : 'Added. Now upload its PDF.');
    if (!editing) { const b = $('lib-upload'); if (b) b.focus(); }
  } },
  h('p', { class: 'db-note', text: `A standing document: one that goes with many proposals, not one job. Give its title and facts as printed on it. Only a document code ${BRAND.name} has allocated; never invent one.` }),
  h('div', { class: 'lib-form-grid' },
    sel('lib-f-owner', 'Whose', [['org', `${BRAND.legalName || BRAND.name} (the company)`], ...state.people.map((p) => [p.slug, `${p.name} (personal)`])], owner),
    sel('lib-f-kind', 'Kind', state.kinds, editing ? item.kind : 'insurance'),
    h('div', { class: 'lib-wide' }, txt('lib-f-title', 'Title', editing ? item.title : '', { maxlength: '160', required: true })),
    txt('lib-f-issuer', 'Issued by', editing ? item.issuer : '', { maxlength: '160' }),
    txt('lib-f-number', 'Number (licence, policy)', editing ? item.number : '', { maxlength: '80' }),
    txt('lib-f-code', 'Document code', editing ? item.docCode : '', { maxlength: '60' }),
    sel('lib-f-currency', 'Expires?', state.currencies, editing ? item.currency : 'expires')),
  msg,
  h('div', { class: 'db-actions' },
    h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, icon(editing ? 'check' : 'plus'), h('span', { text: editing ? 'Save' : 'Add it' })),
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => (editing ? openItem(item.id) : panel.close()) }, h('span', { text: 'Cancel' }))));
  panel.replaceChildren(panelHead(editing ? `Edit “${item.title}”` : 'Add a document'), h('div', { class: 'db-panel-body' }, form));
  $('lib-f-title').focus();
}

/* ------------------------------------------------------------------ boot */

async function reload() {
  const r = await api('POST', '/api/library', { action: 'list' });
  if (!r.ok) {
    $('db-loading').hidden = true;
    const err = $('db-error');
    err.hidden = false;
    err.textContent = (r.json && r.json.error) || 'The library could not be loaded. Reload the page to try again.';
    return false;
  }
  Object.assign(state, { items: r.json.items, people: r.json.people, kinds: r.json.kinds, currencies: r.json.currencies, today: r.json.today });
  renderAll();
  return true;
}

async function boot() {
  D.documentElement.classList.add('js');
  const me = await api('GET', '/api/auth?action=me');
  if (!me.ok) return;
  state.who = me.json;
  $('db-who').textContent = state.who.name || state.who.email;
  for (const el of D.querySelectorAll('[data-role]')) el.hidden = !can(el.dataset.role);
  $('db-signout').addEventListener('click', async () => { await api('POST', '/api/auth?action=signout'); location.assign('/signin'); });
  if (!(await reload())) return;
  $('db-loading').hidden = true;
  for (const el of D.querySelectorAll('.lib-attention, .lib-list')) el.hidden = false;
  renderFilters();
  for (const [id, key] of [['f-owner', 'owner'], ['f-kind', 'kind'], ['f-show', 'show']]) $(id).addEventListener('change', (e) => { state.f[key] = e.target.value; renderList(); });
  $('f-q').addEventListener('input', (e) => { state.f.q = e.target.value.trim(); renderList(); });
  $('lib-filters').addEventListener('submit', (e) => e.preventDefault());
  $('lib-add').addEventListener('click', () => factsForm(null));
  $('db-panel').addEventListener('click', (e) => { if (e.target === $('db-panel')) $('db-panel').close(); });
  const open = new URLSearchParams(location.search).get('open');
  if (open) openItem(open);
  window.__library = { state };
}

boot();

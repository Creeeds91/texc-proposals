/**
 * The Archive page (templates/archive.html, served behind sign-in by
 * api/archive-page.js; docs/architecture.md §20): every revision ever sent,
 * archived proposals included, found by client, site, service, reference or
 * document code; each one opened exactly as it was sent; a proposal's whole
 * record as one pack; and the keeping periods.
 *
 * Everyone signed in can search, open and preview. An editor or an
 * administrator can download a record pack; only an administrator changes the
 * keeping periods. api/archive.js holds every rule again. Nothing from the
 * data is ever written as HTML.
 */
import { h, icon, apiFor } from './staff-ui.js';
import { buildPack } from './record-pack.js';

const D = document;
const $ = (id) => D.getElementById(id);
const api = apiFor('/archive');
const BRAND = JSON.parse($('brand-data').textContent);
const RANK = { viewer: 1, editor: 2, admin: 3, super: 4 };
const state = { who: null, rows: [], years: [], services: {}, regions: [], retention: null, f: { q: '', year: '', service: '', region: '', show: 'all', proposal: '' }, building: false };
const can = (role) => (RANK[state.who && state.who.role] || 0) >= RANK[role];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (iso) => (iso ? dayFmt.format(new Date(iso)) : '');
const at = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
const kb = (n) => (!n ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const SHOW = [['all', 'Every proposal'], ['live', 'Not archived'], ['archived', 'Archived only'], ['practice', 'Practice only']];

let toastTimer = null;
function toast(text) {
  const t = $('db-toast');
  const panel = $('db-panel');
  (panel.open ? panel : D.body).append(t);
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ------------------------------------------------------------ the address */

function readAddress() {
  const q = new URLSearchParams(location.search);
  for (const k of ['q', 'year', 'service', 'region', 'show', 'proposal']) if (q.get(k)) state.f[k] = q.get(k).slice(0, 200);
  if (!SHOW.some(([k]) => k === state.f.show)) state.f.show = 'all';
}

function writeAddress() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(state.f)) if (v && !(k === 'show' && v === 'all')) q.set(k, v);
  const s = q.toString();
  history.replaceState(null, '', s ? `/archive?${s}` : '/archive');
}

/* -------------------------------------------------------- keeping periods */

function renderKeep() {
  const k = state.retention || {};
  const notSet = (text) => h('span', {}, h('span', { class: 'arc-confirm', text: 'Not set' }), ' ', text);
  const rows = [
    ['Expired without acceptance', k.archiveAfterDays
      ? `Archived automatically ${plural(k.archiveAfterDays, 'day')} after it ran out, if nothing has changed on it since. Archiving never deletes.`
      : notSet(`Nothing is archived automatically until ${BRAND.name} sets a period.`)],
    ['Accepted', k.keepAcceptedYears
      ? `Kept for ${plural(k.keepAcceptedYears, 'year')} after its acceptance. Only after that can it be deleted.`
      : notSet(`Kept, and can never be deleted, until ${BRAND.name} sets a period.`)],
    ['Never accepted', 'Can be deleted 90 days after it was archived, by Brand in Black only, and only by typing its reference.'],
  ];
  $('arc-keep-list').replaceChildren(...rows.flatMap(([label, value]) => [h('dt', { text: label }), h('dd', {}, value)]),
    k.updatedAt ? h('p', { class: 'db-note arc-keep-by', text: `Last changed ${at(k.updatedAt)} by ${k.updatedBy || 'unknown'}.` }) : null);
}

function editKeep() {
  const panel = $('db-panel');
  const k = state.retention || {};
  const field = (name, label, unit, lo, hi, value) => h('label', { class: 'db-control arc-keep-field' },
    h('span', { class: 'db-control-label', text: label }),
    h('span', { class: 'arc-unit' }, h('input', { type: 'number', name, min: lo, max: hi, step: 1, inputmode: 'numeric', value: value == null ? '' : value }), h('span', { text: unit })),
    h('span', { class: 'db-note', text: `${lo} to ${hi}, or leave it blank for “not set”.` }));
  const err = h('p', { class: 'db-error', role: 'alert' });
  const form = h('form', { class: 'arc-keep-form' },
    h('p', { class: 'db-warn' }, icon('alert-triangle'), h('span', { text: `These are ${BRAND.name}’s to decide, and are recorded with your name. Set them only as ${BRAND.name} has directed.` })),
    field('archiveAfterDays', 'Archive proposals that expired without acceptance', 'days after they ran out', 7, 3650, k.archiveAfterDays),
    field('keepAcceptedYears', 'Keep accepted proposals', 'years after acceptance', 1, 100, k.keepAcceptedYears),
    err,
    h('div', { class: 'db-actions' },
      h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, h('span', { text: 'Save' })),
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => panel.close() }, h('span', { text: 'Cancel' }))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const r = await api('POST', '/api/archive', { action: 'retention-set', archiveAfterDays: form.elements.archiveAfterDays.value.trim(), keepAcceptedYears: form.elements.keepAcceptedYears.value.trim() });
    if (!r.ok) { err.textContent = (r.json && r.json.error) || 'The change could not be saved.'; return; }
    state.retention = r.json.retention;
    renderKeep();
    panel.close();
    toast('Keeping periods saved.');
  });
  panel.replaceChildren(panelHead('Keeping periods'), h('div', { class: 'db-panel-body' }, form));
  panel.showModal();
  form.elements.archiveAfterDays.focus();
}

function panelHead(title, { closable = true } = {}) {
  const panel = $('db-panel');
  return h('div', { class: 'db-panel-head' },
    h('h2', { class: 'db-h3', id: 'db-panel-title', text: title }),
    h('button', { type: 'button', class: 'db-close', 'aria-label': 'Close', disabled: !closable, onclick: () => panel.close() }, icon('x')));
}

/* ---------------------------------------------------------------- the list */

function visible(row) {
  const s = state.f.show;
  if (s === 'practice') return row.practice;
  if (row.practice) return false;
  if (s === 'live') return !row.archivedAt;
  if (s === 'archived') return !!row.archivedAt;
  return true;
}

/** Revisions grouped by proposal, newest send first. */
function groups() {
  const by = new Map();
  for (const r of state.rows.filter(visible)) {
    if (!by.has(r.proposalId)) by.set(r.proposalId, []);
    by.get(r.proposalId).push(r);
  }
  return [...by.values()];
}

function revState(r) {
  if (r.withdrawnAt) return h('span', { class: 'db-badge db-badge--stop' }, icon('circle-x'), h('span', { text: `Withdrawn ${day(r.withdrawnAt)}` }));
  if (r.supersededAt) return h('span', { class: 'db-badge db-badge--quiet' }, icon('layers'), h('span', { text: `Superseded ${day(r.supersededAt)}` }));
  if (r.current) return h('span', { class: 'db-badge db-badge--go' }, icon('check-circle'), h('span', { text: 'Current' }));
  return null;
}

const words = () => state.f.q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const docHit = (d) => { const w = words(); const hay = `${d.title} ${d.docCode}`.toLowerCase(); return w.length > 0 && w.every((x) => hay.includes(x)); };

async function preview(r, d) {
  const viewer = await import('./pdf-viewer.js');
  const meta = [d.docCode, d.docRev ? `Rev ${d.docRev}` : '', d.pages ? plural(d.pages, 'page') : '', kb(d.bytes)].filter(Boolean).join(' · ');
  viewer.openViewer({ title: d.title, meta, link: async (o) => {
    const x = await api('POST', '/api/archive', { action: 'file', revision: r.revisionId, card: d.card, download: !!(o && o.download) });
    if (!x.ok) throw Object.assign(new Error('link'), { userMessage: (x.json && x.json.error) || 'The document could not be opened.' });
    return x.json;
  } });
}

function docList(r, open) {
  const listId = `docs-${r.revisionId}`;
  const items = r.documents.map((d) => h('li', { class: `arc-doc${docHit(d) ? ' is-hit' : ''}` },
    h('div', { class: 'arc-doc-main' },
      h('span', { class: 'arc-doc-title', text: d.title || 'Untitled document' }),
      h('span', { class: 'arc-doc-meta', text: [d.docCode, d.docRev ? `Rev ${d.docRev}` : '', d.library ? 'from the library' : '', d.visibility === 'on-request' ? 'shown as available on request' : '', d.sha256 ? `SHA-256 ${d.sha256.slice(0, 12)}…` : ''].filter(Boolean).join(' · ') })),
    d.visibility === 'client' && d.sha256 ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => preview(r, d) }, icon('eye'), h('span', { text: 'View' })) : null));
  const list = h('ul', { class: 'arc-docs', id: listId, hidden: !open }, items);
  const toggle = r.documents.length ? h('button', { type: 'button', class: 'db-textbtn', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': listId, onclick: (e) => {
    list.hidden = !list.hidden;
    e.currentTarget.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
  } }, icon('file-text'), h('span', { text: `${plural(r.documents.length, 'document')} sent` })) : h('span', { class: 'arc-none', text: 'No documents sent' });
  return { toggle, list };
}

function revRow(r) {
  const { toggle, list } = docList(r, r.documents.some(docHit));
  const a = r.acceptance;
  return h('li', { class: 'arc-rev' },
    h('div', { class: 'arc-rev-main' },
      h('p', { class: 'arc-rev-head' }, h('span', { class: 'arc-rev-label', text: `Rev ${r.rev}` }), revState(r)),
      h('p', { class: 'arc-rev-sent', text: `Sent ${at(r.publishedAt)}${r.publishedBy ? ` by ${r.publishedBy}` : ''}` }),
      a ? h('p', { class: 'arc-rev-acc' }, icon('check-circle'), h('span', { text: `${a.kind === 'staff' ? 'Acceptance recorded by staff' : 'Accepted'} ${at(a.acceptedAt)}: ${[a.name, a.company].filter(Boolean).join(', ')}` })) : null,
      r.note ? h('p', { class: 'arc-rev-note', text: r.note }) : null,
      toggle),
    h('div', { class: 'arc-rev-actions' },
      h('a', { class: 'btn btn--secondary btn--sm', href: `/staff/revision/${r.revisionId}`, target: '_blank', rel: 'noopener' }, icon('eye'), h('span', { text: 'Open as sent' })),
      a ? h('a', { class: 'db-textbtn', href: `/staff/acceptance/${a.id}`, target: '_blank', rel: 'noopener' }, icon('file-check'), h('span', { text: 'Acceptance record' })) : null),
    list);
}

function propCard(revs) {
  const p = revs[0];
  const accepted = revs.some((r) => r.acceptance);
  const where = [p.locality, p.region].filter(Boolean).join(', ');
  const services = (p.services || []).map((s) => state.services[s] || s).join(' · ');
  return h('article', { class: 'arc-prop', 'aria-labelledby': `p-${p.proposalId}` },
    h('header', { class: 'arc-prop-head' },
      h('div', { class: 'arc-prop-id' },
        h('h3', { class: 'arc-prop-title', id: `p-${p.proposalId}` }, h('span', { class: 'db-ref', text: p.reference || 'No reference' }), h('span', { class: 'arc-prop-project', text: p.project || 'Untitled proposal' })),
        h('p', { class: 'arc-prop-sub', text: [p.client, where].filter(Boolean).join(' · ') }),
        services ? h('p', { class: 'arc-prop-services', text: services }) : null),
      h('div', { class: 'arc-prop-state' },
        accepted ? h('span', { class: 'db-badge db-badge--go' }, icon('check-circle'), h('span', { text: 'Accepted' })) : null,
        p.archivedAt ? h('span', { class: 'db-badge db-badge--quiet', title: p.archiveReason || '' }, icon('archive'), h('span', { text: `Archived ${day(p.archivedAt)}` })) : null,
        p.practice ? h('span', { class: 'db-tag', text: 'Practice' }) : null)),
    p.archivedAt && p.archiveReason ? h('p', { class: 'arc-prop-reason' }, icon('archive'), h('span', { text: p.archiveReason })) : null,
    h('ol', { class: 'arc-revs', reversed: true }, revs.map(revRow)),
    h('footer', { class: 'arc-prop-foot' },
      can('editor') ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => pack(p) }, icon('download'), h('span', { text: 'Record pack' })) : null,
      h('span', { class: 'db-note', text: can('editor') ? 'Every revision as published, each document as stored, the acceptance and the full history, with their fingerprints checked.' : 'An editor or an administrator can download this proposal’s record pack.' })));
}

function render() {
  const gs = groups();
  const n = gs.reduce((k, g) => k + g.length, 0);
  $('arc-count').textContent = n ? `${plural(n, 'revision')} of ${plural(gs.length, 'proposal')}${state.rows.length >= 300 ? ' (the newest 300; narrow the search to see older ones)' : ''}` : '';
  $('arc-groups').replaceChildren(...gs.map(propCard));
  const empty = $('arc-empty');
  empty.hidden = n > 0;
  empty.textContent = state.f.q || state.f.year || state.f.service || state.f.region || state.f.proposal ? 'Nothing sent matches. Try fewer words, or another year.' : 'Nothing has been sent yet. Each revision appears here as it is published.';
  const one = $('arc-one');
  one.hidden = !state.f.proposal;
  if (state.f.proposal) {
    const g = gs[0];
    one.replaceChildren(h('span', { text: `Showing one proposal${g ? `: ${g[0].reference || g[0].project}` : ''}.` }), ' ',
      h('button', { type: 'button', class: 'db-textbtn', onclick: () => setFilter('proposal', '') }, h('span', { text: 'Show everything' })));
  }
}

function fillSelects() {
  const opts = (el, list, value) => el.replaceChildren(...list.map(([v, t]) => h('option', { value: v, selected: v === value, text: t })));
  opts($('f-year'), [['', 'Any year'], ...state.years.map((y) => [String(y), String(y)])], state.f.year);
  opts($('f-service'), [['', 'Any service'], ...Object.entries(state.services).sort((a, b) => a[1].localeCompare(b[1]))], state.f.service);
  opts($('f-region'), [['', 'Any region'], ...state.regions.map((r) => [r, r])], state.f.region);
  opts($('f-show'), SHOW, state.f.show);
}

/* ------------------------------------------------------------- record pack */

async function pack(p) {
  if (state.building) return;
  state.building = true;
  const panel = $('db-panel');
  const log = h('ol', { class: 'arc-pack-log', 'aria-live': 'polite' });
  const bar = h('progress', { class: 'arc-pack-bar', max: 1, value: 0, 'aria-label': 'Record pack progress' });
  const out = h('div', { class: 'arc-pack-out' });
  const body = h('div', { class: 'db-panel-body' },
    h('p', { class: 'db-panel-sub', text: `${p.reference || p.project}: every revision, document, acceptance and event, checked against the fingerprints recorded when they were made. Keep this window open until it is ready.` }),
    bar, log, out);
  panel.replaceChildren(panelHead('Record pack', { closable: false }), body);
  panel.showModal();
  let last = '';
  const step = (text, done, total) => {
    if (total) { bar.max = total; bar.value = done; }
    if (text !== last) { log.append(h('li', { text })); last = text; log.scrollTop = log.scrollHeight; }
  };
  try {
    const res = await buildPack({ proposalId: p.proposalId, api, step, brand: BRAND.name, services: state.services });
    bar.value = bar.max;
    const url = URL.createObjectURL(res.blob);
    const good = res.checks.length - res.bad.length;
    out.replaceChildren(
      res.bad.length
        ? h('div', { class: 'arc-pack-verdict is-bad', role: 'alert' }, icon('alert-triangle'), h('div', {},
          h('p', { text: `${plural(res.bad.length, 'item')} could not be confirmed. ${good} of ${res.checks.length} fingerprints match.` }),
          h('ul', {}, res.bad.map((c) => h('li', { text: `${c.what}: ${c.matches === false ? 'does not match the fingerprint recorded for it' : c.error || 'missing'}` }))),
          h('p', { class: 'db-note', text: 'The pack still holds everything that could be fetched, and its cover names the problem. Tell Brand in Black.' })))
        : h('p', { class: 'arc-pack-verdict', role: 'status' }, icon('check-circle'), h('span', { text: `Ready. All ${res.checks.length} recorded fingerprints match.` })),
      h('p', { class: 'db-actions' },
        h('a', { class: 'btn btn--primary btn--sm', href: url, download: res.name }, icon('download'), h('span', { text: `Save ${res.name} (${kb(res.blob.size)})` }))));
    out.querySelector('a[download]').click();
  } catch (err) {
    out.replaceChildren(h('p', { class: 'db-error', role: 'alert', text: (err && err.userMessage) || 'The pack could not be made. Try again.' }));
  } finally {
    state.building = false;
    panel.querySelector('.db-close').disabled = false;
  }
}

/* ------------------------------------------------------------------ boot */

async function load() {
  const { q, year, service, region, proposal } = state.f;
  const r = await api('POST', '/api/archive', { action: 'search', q, year, service, region, proposal });
  if (!r.ok) {
    $('db-loading').hidden = true;
    const err = $('db-error');
    err.hidden = false;
    err.textContent = (r.json && r.json.error) || 'The archive could not be loaded. Reload the page to try again.';
    return false;
  }
  Object.assign(state, { rows: r.json.rows, years: r.json.years, services: r.json.services || {}, regions: r.json.regions || [], retention: r.json.retention });
  $('db-error').hidden = true;
  render();
  return true;
}

let seq = 0;
async function setFilter(k, v) {
  state.f[k] = v;
  writeAddress();
  if (k === 'show') { render(); return; }
  const mine = (seq += 1);
  const r = await api('POST', '/api/archive', { action: 'search', ...state.f });
  if (mine !== seq || !r.ok) return;
  state.rows = r.json.rows;
  render();
}

let typing = 0;
function onSearch(e) {
  clearTimeout(typing);
  typing = setTimeout(() => setFilter('q', e.target.value.trim().slice(0, 200)), 250);
}

async function boot() {
  D.documentElement.classList.add('js');
  const me = await api('GET', '/api/auth?action=me');
  if (!me.ok) return;
  state.who = me.json;
  $('db-who').textContent = state.who.name || state.who.email;
  for (const el of D.querySelectorAll('[data-role]')) el.hidden = !can(el.dataset.role);
  $('db-signout').addEventListener('click', async () => { await api('POST', '/api/auth?action=signout'); location.assign('/signin'); });
  readAddress();
  $('f-q').value = state.f.q;
  if (!(await load())) return;
  $('db-loading').hidden = true;
  fillSelects();
  renderKeep();
  for (const el of D.querySelectorAll('.arc-keep, .arc-list')) el.hidden = false;
  writeAddress();
  for (const k of ['year', 'service', 'region', 'show']) $(`f-${k}`).addEventListener('change', (e) => setFilter(k, e.target.value));
  $('f-q').addEventListener('input', onSearch);
  $('arc-filters').addEventListener('submit', (e) => e.preventDefault());
  $('arc-keep-edit').addEventListener('click', editKeep);
  $('db-panel').addEventListener('cancel', (e) => { if (state.building) e.preventDefault(); });
  $('db-panel').addEventListener('click', (e) => { if (e.target === $('db-panel') && !state.building) $('db-panel').close(); });
  window.__archive = { state };
}

boot();

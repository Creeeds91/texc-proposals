/**
 * The dashboard (templates/dashboard.html, served behind sign-in by
 * api/dashboard.js): the period's figures, twelve months of issued and
 * accepted, who needs a follow-up, every proposal with search and filters,
 * and one proposal's whole history.
 *
 * Every state and number comes from assets/js/lifecycle.js — the module the
 * CSV export uses — so the screen and the file cannot disagree. Nothing from
 * the data is ever written as HTML; the chart is SVG built node by node and
 * coloured by class (dashboard.css), never by a value in this file.
 */
import {
  STATES, PERIODS, SORTS, figures, monthly, listRows, followUpList, facets, dayLabel, hobartDate, titleOf, periodLabel, stateOf, followUps,
  PURGE_AFTER_DAYS, purgeableFrom, keptUntil,
} from './lifecycle.js';
import { DOC_TYPES } from './schema.js';
import { formatAUD } from './money.js';
import { h, s, icon, apiFor } from './staff-ui.js';

const D = document;
const $ = (id) => D.getElementById(id);

/* ------------------------------------------------------------------ small helpers */

const api = apiFor('/dashboard');

const dollars = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const whole = (cents) => (Number.isFinite(Number(cents)) && cents !== null ? dollars.format(Math.round(Number(cents) / 100)) : '—');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const when = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');

function ago(iso) {
  if (!iso) return '—';
  const days = Math.round((new Date(`${hobartDate(state.now)}T00:00:00Z`) - new Date(`${hobartDate(iso)}T00:00:00Z`)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  return dayLabel(iso);
}

let toastTimer = null;
let toastEl = null;
function toast(text) {
  // Held by reference: redrawing the panel removes it from the page, never from here.
  toastEl = toastEl || $('db-toast');
  const el = toastEl;
  // An open side panel is in the browser's top layer: the message goes with it, or it would sit behind.
  const panel = $('db-panel');
  (panel.open ? panel : D.body).append(el);
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ------------------------------------------------------------------ state */

const RANK = { viewer: 1, editor: 2, admin: 3, super: 4 };
const state = {
  who: null,
  rows: [],
  services: {},
  now: new Date(),
  f: { period: 'fy', q: '', state: '', region: '', service: '', sort: 'activity' },
  ids: null,
};
const can = (role) => (RANK[state.who && state.who.role] || 0) >= RANK[role];
const serviceName = (slug) => state.services[slug] || slug;

/** Filters live in the address, so a reload or a shared link shows the same list. */
function readAddress() {
  const q = new URLSearchParams(location.search);
  const f = state.f;
  if (PERIODS[q.get('period')]) f.period = q.get('period');
  if (q.get('state') === 'followup' || STATES[q.get('state')]) f.state = q.get('state');
  if (SORTS[q.get('sort')]) f.sort = q.get('sort');
  f.region = (q.get('region') || '').slice(0, 60);
  f.service = (q.get('service') || '').slice(0, 40);
  f.q = (q.get('q') || '').slice(0, 200);
}

function listQuery() {
  const f = state.f;
  const q = new URLSearchParams();
  for (const k of ['state', 'region', 'service', 'q']) if (f[k]) q.set(k, f[k]);
  if (f.sort !== 'activity') q.set('sort', f.sort);
  return q;
}

function writeAddress() {
  const q = listQuery();
  if (state.f.period !== 'fy') q.set('period', state.f.period);
  const text = q.toString();
  history.replaceState(null, '', text ? `/dashboard?${text}` : '/dashboard');
  $('db-export').href = `/api/export${listQuery().toString() ? `?${listQuery()}` : ''}`;
}

/* ------------------------------------------------------------------ figures */

function renderFigures() {
  const f = figures(state.rows, state.f.period, state.now);
  const base = f.issued - f.withdrawn;
  const tile = (label, value, sub, extra = '') => h('li', { class: `db-tile${extra}` },
    h('p', { class: 'db-tile-label', text: label }), h('p', { class: 'db-tile-value', text: value }), h('p', { class: 'db-tile-sub', text: sub }));
  $('db-tiles').replaceChildren(
    tile('Issued', String(f.issued), f.issued ? `${plural(f.issued, 'proposal')} sent` : 'Nothing issued in this period'),
    tile('Accepted', String(f.accepted), f.withdrawn ? `${f.withdrawn} withdrawn` : 'accepted so far'),
    tile('Win rate', f.winRate == null ? '—' : `${Math.round(f.winRate * 100)}%`, f.winRate == null ? 'Shown once something is issued' : `${f.accepted} of ${base}`),
    tile('Accepted value', whole(f.acceptedValueCents), 'ex GST, priced items'),
    tile('Open pipeline', whole(f.pipelineValueCents), `${plural(f.pipelineCount, 'proposal')} still out · now`, ' db-tile--now'),
  );
  const scope = state.f.period === 'all' ? 'Every proposal issued so far' : `Proposals first issued ${periodLabel(state.f.period, state.now)}`;
  $('db-figures-note').textContent = `${scope}. Win rate leaves out withdrawn proposals. Practice proposals are never counted. Open pipeline is as of today, whatever the period.`;
}

/* ------------------------------------------------------------------ the chart */

const SERIES = [
  { key: 'issued', label: 'Issued' },
  { key: 'accepted', label: 'Accepted' },
];

function niceStep(max) {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) if (max / step <= 5) return step;
  return Math.ceil(max / 5);
}

/** A bar with a 4px rounded data end, anchored square to the baseline. */
function barPath(x, y, w, base) {
  const r = Math.min(4, w / 2, base - y);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function renderChart() {
  const months = monthly(state.rows, state.now);
  const plot = $('db-plot');
  $('db-legend').replaceChildren(...SERIES.map((x) => h('li', {}, h('span', { class: `db-swatch db-swatch--${x.key}`, 'aria-hidden': 'true' }), h('span', { text: x.label }))));

  // The table twin: the same numbers, readable without the picture.
  $('db-chart-table').replaceChildren(h('table', { class: 'db-mini' },
    h('caption', { class: 'sr-only', text: 'Proposals issued and accepted, by month' }),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Month' }), ...SERIES.map((x) => h('th', { scope: 'col', class: 'n', text: x.label })))),
    h('tbody', {}, months.map((m) => h('tr', {}, h('th', { scope: 'row', text: m.longLabel }), ...SERIES.map((x) => h('td', { class: 'n', text: String(m[x.key]) })))))));

  const top = Math.max(0, ...months.flatMap((m) => SERIES.map((x) => m[x.key])));
  if (!top) {
    plot.replaceChildren(h('p', { class: 'db-plot-empty', text: 'Nothing issued or accepted in the last 12 months yet. The chart fills in as proposals go out.' }));
    return;
  }
  const W = Math.max(280, plot.clientWidth);
  const H = 220;
  const m = { l: 30, r: 6, t: 22, b: 26 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const step = niceStep(top);
  const yMax = Math.max(step * Math.ceil(top / step), step);
  const y = (v) => m.t + ih - (v / yMax) * ih;
  const base = m.t + ih;
  const gw = iw / months.length;
  const bw = Math.max(4, Math.min(24, Math.floor((gw - 8 - 2) / 2)));
  const every = gw < 34 ? 2 : 1;

  const svg = s('svg', { class: 'db-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Proposals issued and accepted, by month. Each month can be focused to hear its figures.' });
  const grid = s('g', { 'aria-hidden': 'true' });
  for (let v = 0; v <= yMax; v += step) {
    grid.append(s('line', { class: v === 0 ? 'db-baseline' : 'db-grid', x1: m.l, x2: W - m.r, y1: Math.round(y(v)) + 0.5, y2: Math.round(y(v)) + 0.5 }));
    grid.append(s('text', { class: 'db-axis', x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  }
  svg.append(grid);

  const tip = h('div', { class: 'db-tip', hidden: true, 'aria-hidden': 'true' });
  const show = (i, g) => {
    svg.querySelectorAll('.db-col.is-on').forEach((x) => x.classList.remove('is-on'));
    g.classList.add('is-on');
    const mo = months[i];
    tip.replaceChildren(h('p', { class: 'db-tip-head', text: mo.longLabel }),
      ...SERIES.map((x) => h('p', { class: 'db-tip-row' }, h('span', { class: `db-swatch db-swatch--${x.key}` }), h('span', { text: x.label }), h('b', { text: String(mo[x.key]) }))));
    tip.hidden = false;
    // Beside the column, never over it: right of it in the first half, left of it in the second.
    const tw = tip.offsetWidth;
    const left = i < months.length / 2 ? m.l + gw * (i + 1) + 6 : m.l + gw * i - tw - 6;
    tip.style.left = `${Math.min(Math.max(left, 0), W - tw)}px`;
    tip.style.top = `${m.t}px`;
  };
  const hide = (g) => { g.classList.remove('is-on'); tip.hidden = true; };

  months.forEach((mo, i) => {
    const gx = m.l + gw * i;
    const g = s('g', { class: 'db-col', tabindex: '0', role: 'img', 'aria-label': `${mo.longLabel}: ${mo.issued} issued, ${mo.accepted} accepted` });
    g.append(s('rect', { class: 'db-hit', x: gx, y: m.t, width: gw, height: ih }));
    const x0 = gx + (gw - (bw * 2 + 2)) / 2;
    SERIES.forEach((x, j) => {
      const v = mo[x.key];
      if (v > 0) g.append(s('path', { class: `db-bar db-bar--${x.key}`, d: barPath(x0 + j * (bw + 2), y(v), bw, base) }));
    });
    // Selective direct labels: this month only, in ink, above its bars.
    if (i === months.length - 1) {
      SERIES.forEach((x, j) => {
        if (mo[x.key] > 0) g.append(s('text', { class: 'db-value', x: x0 + j * (bw + 2) + bw / 2, y: y(mo[x.key]) - 6, 'text-anchor': 'middle', 'aria-hidden': 'true' }, String(mo[x.key])));
      });
    }
    if ((months.length - 1 - i) % every === 0) g.append(s('text', { class: 'db-axis', x: gx + gw / 2, y: H - 8, 'text-anchor': 'middle', 'aria-hidden': 'true' }, mo.label));
    g.addEventListener('pointerenter', () => show(i, g));
    g.addEventListener('pointerleave', () => hide(g));
    g.addEventListener('focus', () => show(i, g));
    g.addEventListener('blur', () => hide(g));
    svg.append(g);
  });
  plot.replaceChildren(svg, tip);
}

/* ------------------------------------------------------------------ badges */

function badge(stateKey) {
  const st = STATES[stateKey] || { label: stateKey, icon: 'info', tone: 'neutral' };
  return h('span', { class: `db-badge db-badge--${st.tone}` }, icon(st.icon), h('span', { text: st.label }));
}

function followNote(fu) {
  if (!fu || !fu.length) return null;
  return h('span', { class: 'db-flag' }, icon('flag'), h('span', { text: fu[0].text }), fu.length > 1 ? h('span', { class: 'db-flag-more', text: ` +${fu.length - 1}` }) : null);
}

/* ------------------------------------------------------------------ follow-ups */

function renderFollowUps() {
  const list = followUpList(state.rows, state.now);
  $('db-follow-count').textContent = list.length ? String(list.length) : '';
  const shown = list.slice(0, 7);
  $('db-follow-list').replaceChildren(...(list.length ? shown.map((r) => h('li', {},
    h('button', { type: 'button', class: 'db-follow-item', onclick: () => openDetail(r.id) },
      h('span', { class: 'db-follow-title', text: titleOf(r) }),
      h('span', { class: 'db-follow-client', text: [r.client_company, r.contact].filter(Boolean).join(' · ') }),
      followNote(r.followUps))))
    : [h('li', { class: 'db-follow-none' }, icon('check-circle'), h('span', { text: 'Nothing needs a call today.' }))]),
  ...(list.length > shown.length ? [h('li', {}, h('button', { type: 'button', class: 'db-textbtn', onclick: () => { setFilter('state', 'followup'); $('db-list-h').scrollIntoView(); } }, `Show all ${list.length} in the list`))] : []));
}

/* ------------------------------------------------------------------ the list */

function stateCounts() {
  const out = { '': 0, followup: 0 };
  for (const r of state.rows) {
    const st = stateOf(r, state.now);
    out[st] = (out[st] || 0) + 1;
    if (st !== 'archived') out[''] += 1;
    if (st !== 'archived' && followUps(r, state.now).length) out.followup += 1;
  }
  return out;
}

function fillSelect(el, options, value) {
  el.replaceChildren(...options.map(([v, label]) => h('option', { value: v, text: label })));
  el.value = options.some(([v]) => v === value) ? value : options[0][0];
}

function renderFilters() {
  const c = stateCounts();
  const order = ['issued', 'opened', 'engaged', 'changes', 'accepted', 'expired', 'withdrawn', 'draft'];
  fillSelect($('f-state'), [['', `Everything current (${c['']})`], ['followup', `Needs a follow-up (${c.followup})`],
    ...order.map((k) => [k, `${STATES[k].label} (${c[k] || 0})`]), ['archived', `Archived (${c.archived || 0})`]], state.f.state);
  const fc = facets(state.rows);
  fillSelect($('f-region'), [['', 'All regions'], ...fc.regions.map((r) => [r, r])], state.f.region);
  fillSelect($('f-service'), [['', 'All services'], ...fc.services.map((x) => [x, serviceName(x)])], state.f.service);
  fillSelect($('f-sort'), Object.entries(SORTS), state.f.sort);
  fillSelect($('f-period'), Object.entries(PERIODS), state.f.period);
}

function renderList() {
  const rows = listRows(state.rows, { ...state.f, ids: state.ids }, state.now);
  const filtered = state.f.q || state.f.state || state.f.region || state.f.service;
  $('db-list-count').textContent = `${plural(rows.length, 'proposal')}${filtered ? ' match' : ''}`;
  $('db-rows').replaceChildren(...rows.map((r) => {
    const site = [r.site_locality, r.site_region].filter(Boolean).join(', ');
    return h('tr', { class: r.is_test ? 'is-practice' : null },
      h('td', { 'data-label': 'Reference' }, h('span', { class: 'db-ref', text: r.reference || 'Draft' }), r.rev ? h('span', { class: 'db-rev', text: `Rev ${r.rev}` }) : null),
      h('td', { 'data-label': 'Project' },
        h('button', { type: 'button', class: 'db-open', onclick: () => openDetail(r.id) }, titleOf(r)),
        h('span', { class: 'db-client', text: r.client_company || 'No client yet' }),
        r.is_test ? h('span', { class: 'db-tag', text: 'Practice' }) : null),
      h('td', { 'data-label': 'Site', class: site ? null : 'is-empty', text: site || '—' }),
      h('td', { 'data-label': 'Where it stands' }, badge(r.state), followNote(r.followUps)),
      h('td', { 'data-label': 'Value ex GST', class: 'n', text: r.value_cents == null ? '—' : whole(r.value_cents) }),
      h('td', { 'data-label': 'Valid until', text: r.valid_until ? dayLabel(r.valid_until) : '—' }),
      h('td', { 'data-label': 'Last activity', text: ago(r.updated_at) }));
  }));
  const empty = $('db-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = state.rows.length ? 'No proposals match. Clear the search or choose “Everything current”.' : 'No proposals yet. Start one in the editor.';
  $('db-table').hidden = rows.length === 0;
}

function renderAll() {
  renderFigures();
  renderChart();
  renderFollowUps();
  renderFilters();
  renderList();
}

function setFilter(key, value) {
  state.f[key] = value;
  writeAddress();
  if (key === 'period') { renderFigures(); return; }
  renderFilters();
  renderList();
}

let searchSeq = 0;
let searchTimer = null;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('f-q').value.trim();
    state.f.q = q;
    writeAddress();
    const seq = (searchSeq += 1);
    if (!q) { state.ids = null; renderList(); return; }
    const r = await api('GET', `/api/analytics?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return; // a later keystroke already asked
    if (!r.ok) { toast((r.json && r.json.error) || 'Search is not available.'); return; }
    state.ids = new Set(r.json.ids);
    renderList();
  }, 250);
}

/* ------------------------------------------------------------------ one proposal */

const EVENT_TEXT = {
  created: () => ['pen-line', 'Created'],
  published: (e) => ['send', `Revision ${e.meta.rev || e.rev || ''} published`],
  link_emailed: (e) => ['mail', `Link emailed to ${e.meta.to || 'the client'}`],
  link_email_failed: (e) => ['alert-triangle', `The link email to ${e.meta.to || 'the client'} did not send`],
  link_rotated: () => ['lock', 'New link and passphrase made; the old link stopped working'],
  withdrawn: (e) => ['circle-x', `Withdrawn${e.meta.note ? `: “${e.meta.note}”` : ''}`],
  attachment_added: (e) => ['file-text', `Document attached: ${e.meta.name || ''}`],
  attachment_opened: (e) => ['eye', `Opened a document: ${e.meta.title || ''}`],
  attachment_downloaded: (e) => ['download', `Downloaded a document: ${e.meta.title || ''}`],
  option_toggled: (e) => ['check', `${e.meta.on ? 'Ticked' : 'Unticked'} an optional item`],
  printed: () => ['printer', 'Printed it, or saved it as a PDF'],
  pdf_downloaded: () => ['download', 'Downloaded it as a PDF'],
  accepted: (e) => ['check-circle', `Accepted revision ${e.meta.rev || e.rev || ''} online${Number.isSafeInteger(e.meta.total_cents) ? ` (${formatAUD(e.meta.total_cents)} inc GST)` : ''}`],
  acceptance_recorded: (e) => ['check-circle', `Acceptance of revision ${e.meta.rev || e.rev || ''} recorded by staff`],
  acceptance_email_failed: () => ['alert-triangle', 'The acceptance email did not send'],
  changes_requested: (e) => ['message-square', `${e.meta.name || 'The client'} asked for changes`],
  archived: (e) => ['archive', `Archived${e.meta.reason ? `: “${e.meta.reason}”` : ''}`],
  restored: () => ['rotate-ccw', 'Restored from the archive'],
  marked_practice: () => ['info', 'Marked as a practice proposal'],
  unmarked_practice: () => ['info', 'Counted in the figures again'],
};

function timelineItems(events, views) {
  const items = events.map((e) => {
    const meta = e.meta && typeof e.meta === 'object' ? e.meta : {};
    const ev = { ...e, meta };
    const [ico, text] = (EVENT_TEXT[e.event] || (() => ['info', e.event.replace(/_/g, ' ')]))(ev);
    const detail = [];
    if (e.actor) detail.push(e.actor);
    if (e.event === 'changes_requested' && meta.message) detail.push(`“${meta.message}”`);
    if (e.event === 'changes_requested' && meta.email) detail.push(meta.email);
    return { at: e.created_at, ico, text, detail };
  });
  for (const v of views) items.push({ at: v.created_at, ico: 'eye', text: `Opened revision ${v.rev || ''}`, detail: [v.device, v.region].filter(Boolean) });
  return items.sort((a, b) => new Date(b.at) - new Date(a.at));
}

const fact = (label, value) => (value ? [h('dt', { text: label }), h('dd', { text: value })] : []);

async function openDetail(id) {
  const panel = $('db-panel');
  panel.replaceChildren(h('p', { class: 'db-loading', role: 'status', text: 'Loading…' }));
  if (!panel.open) panel.showModal();
  const r = await api('GET', `/api/analytics?id=${id}`);
  if (!r.ok) { panel.replaceChildren(panelHead('Not available'), h('p', { class: 'db-error', text: (r.json && r.json.error) || 'This proposal could not be loaded.' })); return; }
  const p = r.json.proposal;
  const row = state.rows.find((x) => x.id === id) || {};
  const st = stateOf(row, state.now);
  const fu = followUps(row, state.now);
  const current = (p.revisions || []).find((x) => x.current);

  const actions = h('div', { class: 'db-actions' });
  if (can('editor') && !p.archivedAt) actions.append(h('a', { class: 'btn btn--primary btn--sm', href: `/editor/${p.id}` }, icon('pen-line'), h('span', { text: 'Open in the editor' })));
  if (can('editor') && p.url && p.status === 'issued' && !p.archivedAt) {
    actions.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
      try { await navigator.clipboard.writeText(p.url); toast('Client link copied. Send the passphrase separately.'); } catch { window.prompt('Copy the client link:', p.url); }
    } }, icon('copy'), h('span', { text: 'Copy client link' })));
  }
  if (can('editor')) {
    actions.append(p.archivedAt
      ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'db-restore', onclick: () => restore(p) }, icon('rotate-ccw'), h('span', { text: 'Restore' }))
      : h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'db-archive', onclick: () => archiveForm(p, st) }, icon('archive'), h('span', { text: 'Archive…' })));
  }
  if (can('admin')) {
    actions.append(h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => practice(p, !p.practice) }, icon('info'),
      h('span', { text: p.practice ? 'Count it in the figures' : 'Mark as practice' })));
  }

  const items = timelineItems(r.json.events || [], r.json.views || []);
  const timeline = h('ol', { class: 'db-timeline' });
  const drawTimeline = (n) => timeline.replaceChildren(...items.slice(0, n).map((it) => h('li', {},
    icon(it.ico), h('div', {}, h('p', { class: 'db-tl-text', text: it.text }), h('p', { class: 'db-tl-meta', text: [when(it.at), ...it.detail].join(' · ') })))),
  ...(items.length > n ? [h('li', { class: 'db-tl-more' }, h('button', { type: 'button', class: 'db-textbtn', onclick: () => drawTimeline(items.length) }, `Show all ${items.length}`))] : []));
  drawTimeline(40);

  panel.replaceChildren(
    panelHead(titleOf({ ...row, ...p, project: p.project || row.project })),
    h('div', { class: 'db-panel-body' },
      h('p', { class: 'db-panel-sub', text: [p.reference || 'Not yet issued', current ? `Rev ${current.label}` : '', p.client, [row.site_locality, row.site_region].filter(Boolean).join(', ')].filter(Boolean).join(' · ') }),
      h('div', { class: 'db-panel-state' }, badge(st), row.is_test ? h('span', { class: 'db-tag', text: 'Practice' }) : null),
      fu.length ? h('ul', { class: 'db-panel-follow' }, fu.map((x) => h('li', {}, icon('flag'), h('span', { text: x.text })))) : null,
      p.archivedAt ? h('p', { class: 'db-panel-archived' }, icon('archive'), h('span', { text: `Archived ${dayLabel(p.archivedAt)} by ${p.archivedBy || 'staff'}${p.archiveReason ? `: “${p.archiveReason}”` : ''}. Its client link does not open while it is archived.` })) : null,
      actions.childNodes.length ? actions : null,
      purgeLine(p),
      h('h3', { class: 'db-h4', text: 'Facts' }),
      h('dl', { class: 'db-facts' },
        fact('Document', DOC_TYPES[row.doc_type] || ''),
        fact('Services', (row.services || []).map(serviceName).join(', ')),
        fact('Contact', row.contact),
        fact('First issued', p.issuedAt ? dayLabel(p.issuedAt) : ''),
        fact('Current revision', current ? `${current.label}, ${when(current.publishedAt)} by ${current.publishedBy}` : 'Not yet issued'),
        fact('Valid until', row.valid_until ? dayLabel(row.valid_until) : ''),
        fact('Link expires', p.linkExpiresAt ? dayLabel(p.linkExpiresAt) : ''),
        fact('Value ex GST', row.value_cents == null ? '' : `${formatAUD(Number(row.value_cents))} (priced items)`),
        fact('Opens', p.openCount ? `${plural(p.openCount, 'open')} in all; ${plural(row.views_current || 0, 'open')} of this revision` : (current ? 'Not opened yet' : '')),
        fact('Last opened', p.lastOpenedAt ? when(p.lastOpenedAt) : '')),
      (p.acceptances || []).length ? [h('h3', { class: 'db-h4', text: 'Acceptance' }), h('ul', { class: 'db-accepts' }, p.acceptances.map((a) => h('li', { class: a.current ? null : 'is-stale' },
        icon(a.current ? 'check-circle' : 'alert-triangle'),
        h('p', {}, `Rev ${a.rev} accepted by ${a.name}${a.position ? `, ${a.position}` : ''} on ${dayLabel(a.acceptedAt)}${a.kind === 'staff' ? ' (recorded by staff)' : ''}${a.totalCents != null ? ` · ${formatAUD(a.totalCents)} inc GST` : ''}${a.current ? '' : ' · an earlier revision, not this one'}`,
          h('a', { class: 'db-textbtn', href: `/staff/acceptance/${a.id}`, target: '_blank', rel: 'noopener' }, 'Record')))))] : null,
      (p.revisions || []).length ? [h('h3', { class: 'db-h4', text: 'Revisions' }), h('ol', { class: 'db-revs' }, [...p.revisions].reverse().map((x) => h('li', {},
        h('b', { text: `Rev ${x.label}` }),
        h('span', { text: ` ${dayLabel(x.publishedAt)} · ${x.publishedBy}${x.current ? ' · current' : x.withdrawn ? ' · withdrawn' : x.superseded ? ' · superseded' : ''}` }),
        x.note ? h('span', { class: 'db-rev-note', text: ` — ${x.note}` }) : null)))] : null,
      h('h3', { class: 'db-h4', text: 'History' }),
      items.length ? timeline : h('p', { class: 'db-note', text: 'Nothing has happened yet.' })));
}

function panelHead(title) {
  const panel = $('db-panel');
  return h('div', { class: 'db-panel-head' },
    h('h2', { class: 'db-h3', id: 'db-panel-title', text: title }),
    h('button', { type: 'button', class: 'db-close', 'aria-label': 'Close', onclick: () => panel.close() }, icon('x')));
}

const REASONS = ['The client did not go ahead', 'Awarded to another contractor', 'Work completed', 'Duplicate or sent in error', 'Practice or test'];

function archiveForm(p, st) {
  const panel = $('db-panel');
  const reason = h('select', { id: 'db-ar-reason' }, h('option', { value: '', text: 'Choose a reason' }), REASONS.map((x) => h('option', { value: x, text: x })), h('option', { value: 'other', text: 'Something else' }));
  const other = h('input', { type: 'text', id: 'db-ar-other', maxlength: '300', autocomplete: 'off', hidden: true, 'aria-label': 'The reason, in a few words' });
  const msg = h('p', { class: 'db-error', role: 'alert' });
  reason.addEventListener('change', () => { other.hidden = reason.value !== 'other'; if (!other.hidden) other.focus(); });
  const live = st === 'issued' || st === 'opened' || st === 'engaged' || st === 'changes' || st === 'accepted';
  const form = h('form', { class: 'db-archive-form', onsubmit: async (e) => {
    e.preventDefault();
    const why = reason.value === 'other' ? other.value.trim() : reason.value;
    if (why.length < 3) { msg.textContent = 'Choose why it is being archived.'; return; }
    const go = form.querySelector('[type=submit]');
    go.disabled = true;
    const r = await api('POST', '/api/proposals', { action: 'archive', id: p.id, reason: why });
    go.disabled = false;
    if (!r.ok) { msg.textContent = (r.json && r.json.error) || 'It could not be archived.'; return; }
    await reload();
    await openDetail(p.id);
    toast('Archived. It can be restored at any time.');
  } },
  h('h3', { class: 'db-h4', text: 'Archive this proposal' }),
  h('p', { class: 'db-note', text: 'Archiving files it away with its whole history. It is not withdrawn and nothing is deleted; it leaves the editor’s list and can be restored at any time.' }),
  live ? h('p', { class: 'db-warn' }, icon('alert-triangle'), h('span', { text: 'Its client link is live. While it is archived, the link will not open.' })) : null,
  h('label', { class: 'db-control' }, h('span', { class: 'db-control-label', text: 'Why' }), reason), other, msg,
  h('div', { class: 'db-actions' },
    h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, icon('archive'), h('span', { text: 'Archive it' })),
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => openDetail(p.id) }, h('span', { text: 'Cancel' }))));
  const body = panel.querySelector('.db-panel-body');
  body.replaceChildren(form);
  reason.focus();
}

/**
 * Deleting for good, shown only to Brand in Black and only on an archived
 * proposal: when it becomes possible, why it never will be (accepted), or the
 * way in. lib/purge.js and texc_purge() hold every rule again.
 */
function purgeLine(p) {
  if (!can('super') || !p.archivedAt) return null;
  let from = purgeableFrom({ archived_at: p.archivedAt });
  if ((p.acceptances || []).length) {
    // Kept for good, unless TEXC has set a keeping period (Phase 9); then from the later of the two.
    const until = keptUntil(p.acceptances.map((a) => a.acceptedAt), state.retention);
    if (!until) return h('p', { class: 'db-note', text: 'It was accepted, so it is kept as a business record and cannot be deleted.' });
    if (until > state.now) return h('p', { class: 'db-note', text: `It was accepted, so it is kept until ${dayLabel(until)}, the end of its keeping period.` });
    if (until > from) from = until;
  }
  if (from > state.now) return h('p', { class: 'db-note', text: `Brand in Black can delete it permanently from ${dayLabel(from)}, ${PURGE_AFTER_DAYS} days after it was archived.` });
  return h('div', { class: 'db-actions' }, h('button', { type: 'button', class: 'btn btn--secondary btn--sm db-danger', id: 'db-purge', onclick: () => purgeForm(p) }, icon('trash-2'), h('span', { text: 'Delete permanently…' })));
}

function purgeForm(p) {
  const word = p.reference || 'DELETE';
  const input = h('input', { type: 'text', id: 'db-purge-confirm', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'db-purge-help' });
  const msg = h('p', { class: 'db-error', role: 'alert' });
  const form = h('form', { class: 'db-archive-form', onsubmit: async (e) => {
    e.preventDefault();
    if (input.value.trim() !== word) { msg.textContent = `Type ${word} exactly.`; return; }
    const go = form.querySelector('[type=submit]');
    go.disabled = true;
    const r = await api('POST', '/api/proposals', { action: 'purge', id: p.id, confirm: input.value.trim() });
    go.disabled = false;
    if (!r.ok) { msg.textContent = (r.json && r.json.error) || 'It could not be deleted.'; return; }
    $('db-panel').close();
    await reload();
    toast(r.json.filesLeft ? 'Deleted. Some stored files could not be removed; the staff audit lists them.' : 'Deleted permanently. The staff audit keeps a record that it existed.');
  } },
  h('h3', { class: 'db-h4', text: 'Delete this proposal permanently' }),
  h('p', { class: 'db-warn' }, icon('alert-triangle'), h('span', { text: 'This cannot be undone. Every revision, its history, its photographs and documents are deleted. Only the staff audit keeps a note of what it was and who deleted it.' })),
  h('label', { class: 'db-control' }, h('span', { class: 'db-control-label', id: 'db-purge-help', text: `Type ${word} to confirm` }), input), msg,
  h('div', { class: 'db-actions' },
    h('button', { type: 'submit', class: 'btn btn--secondary btn--sm db-danger' }, icon('trash-2'), h('span', { text: 'Delete permanently' })),
    h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => openDetail(p.id) }, h('span', { text: 'Cancel' }))));
  $('db-panel').querySelector('.db-panel-body').replaceChildren(form);
  input.focus();
}

async function restore(p) {
  const r = await api('POST', '/api/proposals', { action: 'restore', id: p.id });
  if (!r.ok) { toast((r.json && r.json.error) || 'It could not be restored.'); return; }
  await reload();
  await openDetail(p.id);
  toast('Restored. It is back in the editor’s list.');
}

async function practice(p, on) {
  const r = await api('POST', '/api/proposals', { action: 'practice', id: p.id, on });
  if (!r.ok) { toast((r.json && r.json.error) || 'It could not be changed.'); return; }
  await reload();
  await openDetail(p.id);
  toast(on ? 'Marked as practice. It is left out of every figure.' : 'It counts in the figures again.');
}

/* ------------------------------------------------------------------ boot */

async function reload() {
  const r = await api('GET', '/api/analytics');
  if (!r.ok) {
    $('db-loading').hidden = true;
    const err = $('db-error');
    err.hidden = false;
    err.textContent = (r.json && r.json.error) || 'The dashboard could not be loaded. Reload the page to try again.';
    return false;
  }
  state.rows = r.json.rows;
  state.services = r.json.services || {};
  state.retention = r.json.retention || null;
  state.now = new Date(r.json.now);
  if (state.f.q) {
    const s2 = await api('GET', `/api/analytics?q=${encodeURIComponent(state.f.q)}`);
    state.ids = s2.ok ? new Set(s2.json.ids) : null;
  }
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
  readAddress();
  $('f-q').value = state.f.q; // once: afterwards the box is the person's, never rewritten under their typing
  const open = new URLSearchParams(location.search).get('open');
  if (!(await reload())) return;
  $('db-loading').hidden = true;
  for (const el of D.querySelectorAll('.db-figures, .db-split, .db-list')) el.hidden = false;
  renderChart(); // now that it has a width
  writeAddress();

  $('f-period').addEventListener('change', (e) => setFilter('period', e.target.value));
  $('f-state').addEventListener('change', (e) => setFilter('state', e.target.value));
  $('f-region').addEventListener('change', (e) => setFilter('region', e.target.value));
  $('f-service').addEventListener('change', (e) => setFilter('service', e.target.value));
  $('f-sort').addEventListener('change', (e) => setFilter('sort', e.target.value));
  $('f-q').addEventListener('input', onSearch);
  $('db-filters').addEventListener('submit', (e) => e.preventDefault());
  $('db-chart-table-btn').addEventListener('click', (e) => {
    const t = $('db-chart-table');
    t.hidden = !t.hidden;
    const btn = e.currentTarget;
    btn.setAttribute('aria-expanded', t.hidden ? 'false' : 'true');
    btn.lastChild.textContent = t.hidden ? 'Show as a table' : 'Hide the table';
  });
  $('db-panel').addEventListener('click', (e) => { if (e.target === $('db-panel')) $('db-panel').close(); });
  let frame = 0;
  new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(renderChart); }).observe($('db-plot'));
  if (open && state.rows.some((r) => r.id === open)) openDetail(open);
  window.__dashboard = { state };
}

boot();

/**
 * The proposal editor: a drawer over the live client page. Every change re-runs
 * applyConfig, so the preview IS the page the client will read.
 *
 *   - one panel per section, in page order: show/hide, drag (or Alt+↑/↓) to
 *     reorder, and a badge saying what is left to do
 *   - fields write straight into the draft config; rows add/duplicate/move/delete
 *   - autosave to the server, with a copy in this browser until it lands and a
 *     plain choice when a colleague saved first (store.js)
 *   - the pre-publish checklist, from the same rules the server applies, and
 *     publishing from it (checklist.js)
 *
 * /editor/<id> opens a proposal; /editor alone opens the list of proposals.
 * Phone: the drawer is a full-screen sheet with an Edit / Preview switch.
 */
import { applyConfig, initEffects, setHooks } from '../proposal.js';
import { SECTIONS, PINNED_FIRST, PINNED_LAST, visibleSections, STATUS } from '../schema.js';
import { runChecks } from '../checks.js';
import { h, icon, getIn, setIn, clone, announce, toPath } from './dom.js';
import { panelFor } from './panels.js';
import { renderField } from './fields.js';
import { serverSaver, readBackup, clearBackup, sameContent } from './store.js';
import { previewMedia, uploadMedia } from './media.js';
import { openChecklist } from './checklist.js';
import { api } from './api.js';
import { openPeople } from './people.js';
import { loadFiles, filesContext, previewHook } from './attachments.js';

const D = document;
const ROOT = D.documentElement;
const readJson = (id) => { try { return JSON.parse(D.getElementById(id).textContent); } catch { return {}; } };
const BRAND = readJson('brand-data');
const TPL = readJson('template-data');
const LIB = readJson('library-data');
const LABEL = Object.fromEntries(SECTIONS.map((s) => [s.id, s.label]));
const MOVABLE = (id) => !PINNED_FIRST.includes(id) && !PINNED_LAST.includes(id);
const HIDEABLE = (id) => id !== 'cover' && id !== 'contact';
const PROPOSAL_ID = (location.pathname.match(/^\/editor\/([0-9a-f-]{36})\/?$/) || [])[1] || '';

const state = { cfg: null, open: new Set(['cover']), checks: null, who: null, proposal: null };
let saver = { touch() {}, flush: async () => true, force: async () => true, adopt() {}, dirty: () => false, version: () => 0 };

/* ---------------------------------------------------------- the draft */

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function newProposal() {
  return {
    v: 1,
    template: TPL.version || 1,
    meta: { docType: 'shotfiring', status: 'preliminary' },
    layout: { sections: SECTIONS.map((s) => ({ id: s.id, on: !s.off })) },
    scope: { matrix: (LIB.matrixItems || []).map((item) => ({ item, party: { $confirm: `Who is responsible for ${item.toLowerCase()}` } })) },
    terms: {},
    accept: { signature: 'both' },
  };
}

/** Every section appears once in layout.sections, pinned ones where they belong. */
function normaliseLayout(cfg) {
  const given = Array.isArray(cfg.layout?.sections) ? cfg.layout.sections.filter((s) => LABEL[s.id]) : [];
  const on = new Map(SECTIONS.map((s) => [s.id, !s.off]));
  for (const s of given) on.set(s.id, s.on !== false);
  const middle = given.map((s) => s.id).filter(MOVABLE);
  const rest = SECTIONS.map((s) => s.id).filter((id) => MOVABLE(id) && !middle.includes(id));
  const order = [...PINNED_FIRST, ...middle, ...rest, ...PINNED_LAST];
  cfg.layout = { sections: order.map((id) => ({ id, on: id === 'cover' || id === 'contact' ? true : on.get(id) })) };
  return cfg;
}

/* -------------------------------------------------------------- context */

const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });

function onSaveState(status, detail) {
  const el = D.getElementById('ed-saved');
  if (!el) return;
  el.dataset.state = status;
  if (status === 'saved') el.textContent = `Saved ${timeOf(detail || new Date().toISOString())}`;
  else if (status === 'saving') el.textContent = 'Saving…';
  else if (status === 'dirty') el.textContent = 'Unsaved changes';
  else if (status === 'conflict') el.textContent = 'Not saved — someone else saved this proposal';
  else if (status === 'error') el.textContent = `Not saved yet — ${detail || 'trying again shortly'}. Your changes are kept in this browser.`;
}

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(async () => {
    previewQueued = false;
    applyConfig(withIssue(await previewMedia(state.cfg, PROPOSAL_ID)));
  });
}

/** The preview shows the real reference and revision once there is one (the server sets them at publish). */
function withIssue(cfg) {
  const p = state.proposal;
  if (!p || !p.reference) return cfg;
  const current = (p.revisions || []).find((r) => r.current);
  const issueDate = current ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Hobart' }).format(new Date(current.publishedAt)) : undefined;
  return { ...cfg, meta: { ...(cfg.meta || {}), reference: p.reference, rev: current ? current.label : undefined, issueDate } };
}

let badgeTimer = null;
function scheduleBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadges, 250);
}

const ctx = {
  TPL, LIB, BRAND,
  cfg: () => state.cfg,
  who: () => state.who,
  isAdmin: () => !!state.who && (state.who.role === 'admin' || state.who.role === 'super'),
  proposalId: () => PROPOSAL_ID,
  proposal: () => state.proposal,
  get: (path) => getIn(state.cfg, path),
  set(path, value, { structural = false, quiet = false } = {}) {
    setIn(state.cfg, toPath(path), value === undefined ? undefined : value);
    if (quiet) return;
    saver.touch();
    schedulePreview();
    if (structural) renderDrawer();
    else scheduleBadges();
  },
  /** Replace the whole draft (the demo, an import). */
  replace(cfg, message) {
    state.cfg = normaliseLayout(clone(cfg));
    state.open = new Set(['cover']);
    saver.touch();
    renderDrawer();
    schedulePreview();
    window.scrollTo(0, 0);
    announce(message);
  },
  flush: () => saver.flush(),
  version: () => saver.version(),
  async uploadMedia(id, media) {
    toast('Uploading the photograph…');
    const ok = await uploadMedia(PROPOSAL_ID, id, media);
    const now = ctx.get(['media', id]);
    if (ok && now) { ctx.set(['media', id], { ...now, pending: undefined }, { structural: true }); toast('Photograph stored.'); }
    else if (!ok) toast('The photograph did not upload. Choose it again to retry.');
  },
  async refreshProposal() {
    if (!PROPOSAL_ID) return;
    const r = await api('GET', `/api/proposals?id=${PROPOSAL_ID}`);
    if (r.ok) { state.proposal = r.json; renderStatus(); schedulePreview(); scheduleBadges(); }
  },
  checkCtx: () => {
    const a = state.proposal && (state.proposal.acceptances || []).find((x) => x.current);
    return { today: today(), services: TPL.services, register: TPL.register, brand: BRAND.name, files: filesContext(),
      accepted: a ? { rev: a.rev, name: a.name, acceptedAt: a.acceptedAt } : null };
  },
  reveal(section, field) {
    state.open.add(section);
    renderDrawer();
    const panel = D.querySelector(`.ed-panel[data-sec="${section}"]`);
    if (panel) panel.scrollIntoView({ block: 'start' });
    scrollPreviewTo(section);
    if (field) {
      const target = D.querySelector(`.ed-panel[data-sec="${section}"] [data-path^="${String(field).replace(/\[(\d+)\]/g, (m, n) => `.${Number(n) - 1}`)}"] :is(input, textarea, select, button)`);
      if (target) target.focus();
    }
  },
  refresh() { renderDrawer(); schedulePreview(); },
  toast,
};

/** A short notice at the foot of the drawer, with an optional Undo. */
let toastTimer = null;
function toast(text, undo) {
  const host = D.getElementById('ed-toast');
  if (!host) return;
  clearTimeout(toastTimer);
  host.replaceChildren(h('span', { text }));
  if (undo) {
    host.append(h('button', { type: 'button', class: 'ed-linkbtn', onclick: () => { host.hidden = true; undo(); announce('Undone'); } }, icon('undo-2'), ' Undo'));
  }
  host.hidden = false;
  announce(text);
  toastTimer = setTimeout(() => { host.hidden = true; }, 8000);
}

/* -------------------------------------------------------------- drawer */

function scrollPreviewTo(id) {
  const sec = D.getElementById(id);
  if (sec && !sec.hidden) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function orderedIds() {
  return state.cfg.layout.sections.map((s) => s.id);
}

function moveSection(id, delta) {
  const list = state.cfg.layout.sections;
  const i = list.findIndex((s) => s.id === id);
  const j = i + delta;
  if (j < 0 || j >= list.length || !MOVABLE(list[j].id)) return false;
  [list[i], list[j]] = [list[j], list[i]];
  ctx.set('layout.sections', list, { structural: true });
  announce(`${LABEL[id]} moved ${delta < 0 ? 'up' : 'down'}`);
  return true;
}

function dropSection(dragged, target, after) {
  if (dragged === target || !MOVABLE(dragged) || !MOVABLE(target)) return;
  const list = state.cfg.layout.sections.filter((s) => s.id !== dragged);
  const item = state.cfg.layout.sections.find((s) => s.id === dragged);
  const at = list.findIndex((s) => s.id === target) + (after ? 1 : 0);
  list.splice(at, 0, item);
  ctx.set('layout.sections', list, { structural: true });
  announce(`${LABEL[dragged]} moved`);
}

function badgeFor(id, visible) {
  if (!visible.includes(id)) return { text: 'Hidden', tone: 'off' };
  const r = state.checks;
  const acked = new Set(state.cfg.acks || []);
  const fix = r.blockers.filter((b) => b.section === id).length;
  const ack = r.acks.filter((a) => a.section === id && !acked.has(a.key)).length;
  if (fix) return { text: `${fix} to fix`, tone: 'bad' };
  if (ack) return { text: `${ack} to acknowledge`, tone: 'warn' };
  return { text: 'Done', tone: 'ok' };
}

function updateBadges() {
  state.checks = runChecks(state.cfg, ctx.checkCtx());
  const visible = visibleSections(state.cfg);
  for (const panel of D.querySelectorAll('.ed-panel')) {
    const b = badgeFor(panel.dataset.sec, visible);
    const el = panel.querySelector('.ed-badge');
    if (el) { el.textContent = b.text; el.dataset.tone = b.tone; }
  }
  const acked = new Set(state.cfg.acks || []);
  const left = state.checks.blockers.length + state.checks.acks.filter((a) => !acked.has(a.key)).length;
  const count = D.getElementById('ed-check-count');
  if (count) { count.textContent = left ? String(left) : '✓'; count.dataset.tone = left ? 'bad' : 'ok'; }
}

function renderPanel(id, num, visible) {
  const on = visible.includes(id);
  const bodyId = `ed-body-${id}`;
  const open = state.open.has(id);
  const panel = h('section', { class: `ed-panel${on ? '' : ' is-off'}`, dataset: { sec: id } });
  const head = h('div', { class: 'ed-panel-head' });
  if (MOVABLE(id)) {
    const handle = h('button', { type: 'button', class: 'ed-handle', 'aria-label': `Move ${LABEL[id]}. Alt plus arrow up or down.`, title: 'Drag, or Alt+↑ / Alt+↓' }, icon('grip-vertical'));
    handle.addEventListener('keydown', (e) => {
      if (!(e.altKey || e.metaKey) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      if (moveSection(id, e.key === 'ArrowUp' ? -1 : 1)) D.querySelector(`.ed-panel[data-sec="${id}"] .ed-handle`)?.focus();
    });
    head.draggable = true;
    head.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; panel.classList.add('is-dragging'); });
    head.addEventListener('dragend', () => panel.classList.remove('is-dragging'));
    head.append(handle);
  } else {
    head.append(h('span', { class: 'ed-handle is-pinned', title: 'Fixed position' }, icon('lock')));
  }
  const toggle = h('button', { type: 'button', class: 'ed-panel-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId },
    h('span', { class: 'ed-num', text: on ? num : '—' }),
    h('span', { class: 'ed-title', text: LABEL[id] }),
    h('span', { class: 'ed-badge', text: '' }),
    icon('chevron-down', 'ic ed-chev'));
  toggle.addEventListener('click', () => {
    if (state.open.has(id)) state.open.delete(id); else { state.open.add(id); scrollPreviewTo(id); }
    renderDrawer();
  });
  head.append(toggle);
  if (HIDEABLE(id)) {
    const sw = h('input', { type: 'checkbox', role: 'switch', class: 'ed-switch', 'aria-label': `Show ${LABEL[id]} on the page` });
    sw.checked = on;
    sw.addEventListener('change', () => {
      const list = state.cfg.layout.sections.map((s) => (s.id === id ? { ...s, on: sw.checked } : s));
      ctx.set('layout.sections', list, { structural: true });
    });
    head.append(sw);
  }
  panel.append(head);
  panel.addEventListener('dragover', (e) => {
    if (!MOVABLE(id)) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    panel.dataset.drop = e.clientY > r.top + r.height / 2 ? 'after' : 'before';
  });
  panel.addEventListener('dragleave', () => { delete panel.dataset.drop; });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = panel.dataset.drop === 'after';
    delete panel.dataset.drop;
    dropSection(e.dataTransfer.getData('text/plain'), id, after);
  });
  if (open) {
    const body = h('div', { class: 'ed-panel-body', id: bodyId });
    for (const spec of panelFor(id, ctx)) if (spec) body.append(renderField(spec, ctx));
    panel.append(body);
  }
  return panel;
}

function renderDrawer() {
  const host = D.getElementById('ed-panels');
  if (!host) return;
  const keepScroll = host.scrollTop;
  const active = D.activeElement && D.activeElement.closest('[data-path]')?.dataset.path;
  const visible = visibleSections(state.cfg);
  let n = 0;
  host.replaceChildren(...orderedIds().map((id) => {
    const num = visible.includes(id) ? String((n += 1)).padStart(2, '0') : '';
    return renderPanel(id, num, visible);
  }));
  host.scrollTop = keepScroll;
  if (active) D.querySelector(`[data-path="${active}"] :is(input, textarea, select)`)?.focus({ preventScroll: true });
  updateBadges();
}


/* -------------------------------------------------------------- status */

/** Under the drawer's title: the reference, where it stands, and the link. */
function renderStatus() {
  const el = D.getElementById('ed-status');
  if (!el) return;
  const p = state.proposal;
  if (!p) { el.replaceChildren(h('span', { text: PROPOSAL_ID ? '' : 'No proposal open' })); return; }
  const current = (p.revisions || []).find((r) => r.current);
  const bits = [p.reference || 'Not yet issued'];
  if (current) bits.push(`Rev ${current.label} ${p.status === 'withdrawn' ? 'withdrawn' : 'issued'}`);
  if (p.openCount) bits.push(`opened ${p.openCount}×`);
  el.replaceChildren(h('span', { text: bits.join(' · ') }));
  if (p.url && p.status === 'issued') {
    el.append(h('button', { type: 'button', class: 'ed-linkbtn', onclick: () => copy(p.url, 'Client link copied') }, ' Copy link'));
  }
  // Acceptance: the latest one, and whether the current revision still needs it.
  const accepted = (p.acceptances || []).at(-1);
  if (accepted) {
    const day = new Date(accepted.acceptedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Hobart' });
    const line = h('span', { class: `ed-accepted${accepted.current ? '' : ' is-stale'}` }, icon(accepted.current ? 'check-circle' : 'alert-triangle'),
      h('span', { text: accepted.current
        ? `Accepted by ${accepted.name}, ${day}${accepted.kind === 'staff' ? ' (recorded by staff)' : ''}`
        : `Rev ${accepted.rev} accepted ${day}; Rev ${current ? current.label : ''} awaits acceptance` }),
      h('a', { class: 'ed-linkbtn', href: `/staff/acceptance/${accepted.id}`, target: '_blank', rel: 'noopener' }, 'Record'));
    el.append(h('br'), line);
  }
}

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { window.prompt('Copy this:', text); }
}

/* -------------------------------------------------------------- dialogs */

function dialog(title, ...body) {
  const dlg = h('dialog', { class: 'ed-dialog', 'aria-label': title });
  dlg.append(h('div', { class: 'ed-dialog-head' }, h('h2', { text: title }), h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))), ...body);
  dlg.addEventListener('close', () => dlg.remove());
  D.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** The list of proposals: open one, or start a new one. */
async function openPicker({ closable = true } = {}) {
  const listBox = h('div', { class: 'ed-list' }, h('p', { class: 'ed-hint', text: 'Loading…' }));
  const dlg = dialog('Proposals',
    h('div', { class: 'ed-rows-tools' },
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => createAndOpen(newProposal()) }, icon('plus'), h('span', { text: 'New proposal' })),
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
        const r = await api('GET', '/api/editor?fixture=demo');
        if (r.ok) createAndOpen(r.json);
      } }, icon('book-open'), h('span', { text: 'New from the demo (fictional)' }))),
    listBox);
  dlg.classList.add('ed-dialog--wide');
  if (!closable) {
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    dlg.querySelector('.ed-dialog-head .ed-icon').remove();
  }
  const r = await api('GET', '/api/proposals');
  const rows = (r.ok && r.json.proposals) || [];
  listBox.replaceChildren(rows.length
    ? h('ul', { class: 'ed-proposals' }, rows.map((p) => h('li', {},
      h('a', { href: `/editor/${p.id}`, class: 'ed-proposal' },
        h('span', { class: 'ed-proposal-ref', text: p.reference || 'Draft' }),
        h('span', { class: 'ed-proposal-name', text: [p.project || 'Untitled', p.client_company].filter(Boolean).join(' — ') }),
        h('span', { class: 'ed-proposal-meta', text: `${STATUS[p.status] || p.status} · updated ${new Date(p.updated_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` })))))
    : h('p', { class: 'ed-hint', text: 'No proposals yet. Start one above.' }));
}

async function createAndOpen(cfg) {
  const r = await api('POST', '/api/proposals', { action: 'create', config: cfg });
  if (r.ok) location.assign(`/editor/${r.json.id}`);
  else toast((r.json && r.json.error) || 'The proposal could not be created.');
}

/** Someone else saved first: show both choices plainly; never overwrite silently. */
function showConflict(info) {
  const when = info && info.updated_at ? timeOf(info.updated_at) : '';
  const dlg = dialog('Someone else saved this proposal',
    h('p', { class: 'ed-hint ed-block', text: `${(info && info.updated_by) || 'A colleague'} saved it${when ? ` at ${when}` : ''}, after you opened it. Your latest changes are not saved yet.` }),
    h('div', { class: 'ed-dialog-foot' },
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: async () => {
        dlg.close();
        const r = await api('GET', `/api/drafts?id=${PROPOSAL_ID}`);
        if (!r.ok) return;
        saver.adopt(r.json.version);
        state.cfg = normaliseLayout(r.json.config || {});
        renderDrawer();
        schedulePreview();
        onSaveState('saved', r.json.updated_at);
        toast('Loaded their version.');
      } }, 'Load theirs (lose my changes)'),
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: async () => {
        dlg.close();
        if (await saver.force()) toast('Saved yours over theirs. This is recorded.');
      } }, 'Keep mine (replace theirs)')));
  dlg.addEventListener('cancel', (e) => e.preventDefault());
}

/* -------------------------------------------------------------- actions */

function exportJson() {
  const blob = new Blob([JSON.stringify(state.cfg, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${(state.proposal?.reference || 'proposal-draft').replace(/[^\w.-]+/g, '-')}.json` });
  D.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importJson() {
  const input = h('input', { type: 'file', accept: 'application/json,.json', class: 'ed-file' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const cfg = JSON.parse(await file.text());
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a proposal');
      if (window.confirm(`Replace this proposal's content with ${file.name}?`)) ctx.replace(cfg, `Imported ${file.name}`);
    } catch {
      window.alert('That file is not a proposal config.');
    }
  });
  D.body.append(input);
  input.click();
}

async function adminAction(action, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return null;
  const note = action === 'withdraw' ? window.prompt('Why is it being withdrawn? (kept in the record)') : '';
  if (action === 'withdraw' && note === null) return null;
  const r = await api('POST', '/api/proposals', { action, id: PROPOSAL_ID, note });
  if (!r.ok) { toast((r.json && r.json.error) || 'That did not work.'); return null; }
  await ctx.refreshProposal();
  return r.json;
}

function secretDialog(title, lines) {
  dialog(title, ...lines.map(([label, value, hint]) => h('div', { class: 'ed-secret' },
    h('p', { class: 'ed-label', text: label }),
    h('div', { class: 'ed-secret-row' }, h('code', { text: value }), h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => copy(value, `${label} copied`) }, 'Copy')),
    hint ? h('p', { class: 'ed-hint', text: hint }) : null)));
}

function menu() {
  const p = state.proposal;
  const admin = ctx.isAdmin();
  const dlg = h('dialog', { class: 'ed-dialog ed-menu', 'aria-label': 'Menu' });
  const item = (text, iconName, fn, enabled = true) => h('button', { type: 'button', class: 'ed-menu-item', disabled: !enabled, onclick: () => { dlg.close(); fn(); } }, icon(iconName), h('span', { text }));
  const issued = p && p.url && p.status === 'issued';
  dlg.append(
    h('div', { class: 'ed-dialog-head' }, h('h2', { text: 'Menu' }), h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    item('All proposals', 'list', () => openPicker()),
    item('New proposal', 'file-text', () => createAndOpen(newProposal())),
    item('Replace with the demo (fictional client)', 'book-open', async () => {
      if (!window.confirm('Replace this proposal’s content with the demo? This cannot be undone.')) return;
      const r = await api('GET', '/api/editor?fixture=demo');
      if (r.ok) ctx.replace(r.json, 'Demo loaded');
    }, !!PROPOSAL_ID),
    item('Import a config (.json)', 'upload', importJson, !!PROPOSAL_ID),
    item('Export this draft (.json)', 'download', exportJson),
    issued ? item('Copy the client link', 'external-link', () => copy(p.url, 'Client link copied')) : null,
    admin && p && p.reference ? item('Show the passphrase (recorded)', 'lock', async () => {
      const r = await adminAction('passphrase');
      if (r) secretDialog('Passphrase', [['Passphrase', r.passphrase, 'Give it by phone or text message, never in the same email as the link. This read-back is recorded.']]);
    }) : null,
    admin && p && p.reference ? item('New link and passphrase', 'alert-triangle', async () => {
      const r = await adminAction('rotate', 'The current link will stop working at once, for everyone who has it. Make a new link and passphrase?');
      if (r) secretDialog('New link and passphrase', [['Client link', r.url], ['Passphrase', r.passphrase, 'Send the link and the passphrase separately.']]);
    }) : null,
    admin && issued ? item('Withdraw this proposal', 'x', async () => {
      const r = await adminAction('withdraw', 'Withdraw it? The client link will stop working. Publishing again issues a new revision behind the same link.');
      if (r) toast('Withdrawn. The link no longer opens.');
    }) : null,
    admin && issued && !(p.acceptances || []).some((x) => x.current) ? item('Record an acceptance received another way', 'file-check', () => recordAcceptance()) : null,
    admin ? item('People', 'users', () => openPeople(ctx)) : null,
    item('Sign out', 'arrow-left', async () => { await saver.flush(); await api('POST', '/api/auth?action=signout'); location.assign('/signin'); }),
    h('p', { class: 'ed-hint', text: state.who ? `Signed in as ${state.who.email} (${{ super: 'Brand in Black', admin: 'administrator', editor: 'editor', viewer: 'viewer' }[state.who.role] || state.who.role}).` : '' }),
  );
  dlg.addEventListener('close', () => dlg.remove());
  D.body.append(dlg);
  dlg.showModal();
}

/** An administrator records an acceptance that came by email or on paper, with a note saying how. */
function recordAcceptance() {
  const p = state.proposal;
  const current = (p.revisions || []).find((r) => r.current);
  const c = state.cfg.client || {};
  const field = (name, label, value = '', type = 'text') => {
    const id = `ra-${name}`;
    const input = name === 'note'
      ? h('textarea', { id, class: 'ed-input ed-area', rows: 3, maxlength: 500, placeholder: 'e.g. Signed PDF of Rev A returned by email on 14 October' })
      : h('input', { id, class: 'ed-input', type, value: typeof value === 'string' ? value : '', autocomplete: 'off', maxlength: 200 });
    return h('div', { class: 'ed-field' }, h('label', { class: 'ed-label', for: id, text: label }), input);
  };
  const err = h('p', { class: 'ed-error', role: 'alert' });
  const dlg = dialog(`Record an acceptance of Rev ${current ? current.label : ''}`,
    h('p', { class: 'ed-hint ed-block', text: `For an acceptance that reached ${BRAND.name} another way — a signed PDF, an email. It is recorded with your name and your note, the client's page shows the proposal as accepted, and it cannot be undone.` }),
    field('name', 'Who accepted it (full name)', c.contactName),
    field('position', 'Their position', c.contactPosition),
    field('company', 'Company', c.company),
    field('email', 'Their email (optional)', c.email, 'email'),
    field('note', 'How it was received'),
    err,
    h('div', { class: 'ed-dialog-foot' },
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'ra-go', onclick: async () => {
        const v = (k) => D.getElementById(`ra-${k}`).value.trim();
        const r = await api('POST', '/api/proposals', { action: 'record-acceptance', id: PROPOSAL_ID, name: v('name'), position: v('position'), company: v('company'), email: v('email'), note: v('note') });
        if (!r.ok) { err.textContent = (r.json && r.json.error) || 'It could not be recorded.'; return; }
        dlg.close();
        await ctx.refreshProposal();
        toast(`Acceptance of Rev ${r.json.rev} recorded.`);
      } }, 'Record the acceptance')));
  dlg.classList.add('ed-dialog--wide');
}

function buildShell() {
  const drawer = h('aside', { id: 'ed', class: 'ed', 'aria-label': 'Proposal editor' },
    h('div', { class: 'ed-top' },
      h('div', { class: 'ed-brand' }, h('img', { src: BRAND.logoGold, alt: BRAND.name, width: 72, height: 28 }), h('span', { text: 'Editor' })),
      h('div', { class: 'ed-top-actions' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'ed-menu', onclick: menu }, icon('menu'), h('span', { text: 'Menu' })),
        h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'ed-check', onclick: async () => { await ctx.refreshProposal(); openChecklist(ctx); } }, icon('file-check'), h('span', { text: 'Checklist' }), h('span', { class: 'ed-count-pill', id: 'ed-check-count' })))),
    h('p', { class: 'ed-status', id: 'ed-status' }),
    h('p', { class: 'ed-saved', id: 'ed-saved', role: 'status', 'aria-live': 'polite', text: '' }),
    h('div', { class: 'ed-panels', id: 'ed-panels' }),
    h('div', { class: 'ed-toast', id: 'ed-toast', hidden: true }));
  const bar = h('nav', { class: 'ed-mobilebar', 'aria-label': 'Editor view' },
    h('button', { type: 'button', id: 'ed-mode-edit', 'aria-pressed': 'true', onclick: () => setMode('edit') }, icon('pen-line'), h('span', { text: 'Edit' })),
    h('button', { type: 'button', id: 'ed-mode-preview', 'aria-pressed': 'false', onclick: () => setMode('preview') }, icon('eye'), h('span', { text: 'Preview' })));
  const collapse = h('button', { type: 'button', class: 'ed-collapse', id: 'ed-collapse', 'aria-controls': 'ed', 'aria-expanded': 'true', onclick: () => {
    const hidden = ROOT.classList.toggle('ed-collapsed');
    collapse.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    collapse.lastChild.textContent = hidden ? 'Show editor' : 'Hide editor';
  } }, icon('pen-line'), h('span', { text: 'Hide editor' }));
  D.body.append(drawer, bar, collapse, h('div', { id: 'ed-live', class: 'sr-only', 'aria-live': 'polite' }));
}

function setMode(mode) {
  ROOT.classList.toggle('ed-preview', mode === 'preview');
  D.getElementById('ed-mode-edit').setAttribute('aria-pressed', mode === 'edit' ? 'true' : 'false');
  D.getElementById('ed-mode-preview').setAttribute('aria-pressed', mode === 'preview' ? 'true' : 'false');
  if (mode === 'preview') window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  ROOT.classList.add('js', 'ed-on');
  const me = await api('GET', '/api/auth?action=me');
  if (!me.ok) return; // api() has sent the browser to sign in
  state.who = me.json;
  buildShell();

  if (!PROPOSAL_ID) {
    state.cfg = normaliseLayout(newProposal());
    renderDrawer();
    renderStatus();
    applyConfig(state.cfg);
    initEffects(D);
    ROOT.classList.add('ready');
    if (location.hash === '#people' && ctx.isAdmin()) openPeople(ctx);
    else openPicker({ closable: false });
    window.__editor = { ctx, state };
    return;
  }

  const r = await api('GET', `/api/drafts?id=${PROPOSAL_ID}`);
  if (!r.ok) { D.getElementById('ed-saved').textContent = (r.json && r.json.error) || 'This proposal could not be opened.'; openPicker({ closable: false }); return; }
  state.proposal = r.json.proposal;
  state.cfg = normaliseLayout(r.json.config || {});
  saver = serverSaver({ id: PROPOSAL_ID, getCfg: () => state.cfg, version: r.json.version, onState: onSaveState, onConflict: showConflict });
  onSaveState('saved', r.json.updated_at);

  // Changes this browser kept but the server never received.
  const backup = readBackup(PROPOSAL_ID);
  if (backup && backup.baseVersion === r.json.version && !sameContent(backup.cfg, r.json.config)) {
    const dlg = dialog('Unsaved changes found',
      h('p', { class: 'ed-hint ed-block', text: `This browser kept changes from ${timeOf(backup.at)} that did not reach the server.` }),
      h('div', { class: 'ed-dialog-foot' },
        h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => { dlg.close(); ctx.replace(backup.cfg, 'Unsaved changes restored'); } }, 'Restore them'),
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => { dlg.close(); clearBackup(PROPOSAL_ID); } }, 'Discard them')));
  } else if (backup) clearBackup(PROPOSAL_ID);

  renderDrawer();
  renderStatus();
  // The preview's View and Download buttons open this proposal's own files.
  setHooks({ attachment: previewHook(ctx) });
  applyConfig(withIssue(await previewMedia(state.cfg, PROPOSAL_ID)));
  initEffects(D);
  ROOT.classList.add('ready');
  if (location.hash === '#people' && ctx.isAdmin()) openPeople(ctx);
  // What the check found for each attached file; the checklist waits for it.
  // Only the Documents panel shows them; elsewhere the badges are enough, and
  // redrawing the drawer under someone's typing is not.
  loadFiles(PROPOSAL_ID).then((ok) => {
    if (!ok) { toast('The attached files could not be loaded. Reload to try again.'); return; }
    state.filesLoaded = true;
    if (state.open.has('attachments')) renderDrawer(); else updateBadges();
  });

  window.addEventListener('beforeunload', (e) => { if (saver.dirty()) { saver.flush(); e.preventDefault(); } });
  D.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saver.flush().then((ok) => ok && announce('Saved')); }
  });
  window.__editor = { ctx, state, saver: () => saver };
}

boot();

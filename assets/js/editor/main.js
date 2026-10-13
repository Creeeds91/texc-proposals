/**
 * The proposal editor: a drawer over the live client page. Every change re-runs
 * applyConfig, so the preview IS the page the client will read.
 *
 *   - one panel per section, in page order: show/hide, drag (or Alt+↑/↓) to
 *     reorder, and a badge saying what is left to do
 *   - fields write straight into the draft config; rows add/duplicate/move/delete
 *   - autosave to this browser (Phase 3 moves drafts to the server)
 *   - the pre-publish checklist, from the same rules the server will apply
 *
 * Phone: the drawer is a full-screen sheet with an Edit / Preview switch.
 */
import { applyConfig, initEffects } from '../proposal.js';
import { SECTIONS, PINNED_FIRST, PINNED_LAST, visibleSections } from '../schema.js';
import { runChecks } from '../checks.js';
import { h, icon, getIn, setIn, clone, announce, toPath } from './dom.js';
import { panelFor } from './panels.js';
import { renderField } from './fields.js';
import { loadDraft, autosaver, clearDraft } from './store.js';
import { previewMedia } from './media.js';
import { openChecklist } from './checklist.js';

const D = document;
const ROOT = D.documentElement;
const readJson = (id) => { try { return JSON.parse(D.getElementById(id).textContent); } catch { return {}; } };
const BRAND = readJson('brand-data');
const TPL = readJson('template-data');
const LIB = readJson('library-data');
const LABEL = Object.fromEntries(SECTIONS.map((s) => [s.id, s.label]));
const MOVABLE = (id) => !PINNED_FIRST.includes(id) && !PINNED_LAST.includes(id);
const HIDEABLE = (id) => id !== 'cover' && id !== 'contact';

const state = { cfg: null, open: new Set(['cover']), checks: null };

/* ---------------------------------------------------------- the draft */

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function newProposal() {
  return {
    v: 1,
    template: TPL.version || 1,
    meta: { docType: 'shotfiring', status: 'draft' },
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

const saver = autosaver(() => state.cfg, (status, at) => {
  const el = D.getElementById('ed-saved');
  if (!el) return;
  el.dataset.state = status;
  if (status === 'saved') {
    const t = new Date(at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    el.textContent = `Saved ${t} · this browser`;
  } else if (status === 'saving') el.textContent = 'Saving…';
  else if (status === 'dirty') el.textContent = 'Unsaved changes';
  else if (status === 'error') el.textContent = 'Could not save — this browser’s storage is full or blocked';
});

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(async () => {
    previewQueued = false;
    applyConfig(await previewMedia(state.cfg));
  });
}

let badgeTimer = null;
function scheduleBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadges, 250);
}

const ctx = {
  TPL, LIB, BRAND,
  cfg: () => state.cfg,
  get: (path) => getIn(state.cfg, path),
  set(path, value, { structural = false, quiet = false } = {}) {
    setIn(state.cfg, toPath(path), value === undefined ? undefined : value);
    if (quiet) return;
    saver.touch();
    schedulePreview();
    if (structural) renderDrawer();
    else scheduleBadges();
  },
  checkCtx: () => ({ today: today(), services: TPL.services, register: TPL.register, brand: BRAND.name }),
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

/* -------------------------------------------------------------- actions */

function load(cfg, message) {
  state.cfg = normaliseLayout(clone(cfg));
  state.open = new Set(['cover']);
  saver.touch();
  saver.flush();
  renderDrawer();
  schedulePreview();
  window.scrollTo(0, 0);
  announce(message);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.cfg, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${(state.cfg.meta?.reference || 'proposal-draft').replace(/[^\w.-]+/g, '-')}.json` });
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
      load(cfg, `Imported ${file.name}`);
    } catch {
      window.alert('That file is not a proposal config.');
    }
  });
  D.body.append(input);
  input.click();
}

function menu() {
  const dlg = h('dialog', { class: 'ed-dialog ed-menu', 'aria-label': 'Draft' });
  const item = (text, iconName, fn) => h('button', { type: 'button', class: 'ed-menu-item', onclick: () => { dlg.close(); fn(); } }, icon(iconName), h('span', { text }));
  dlg.append(
    h('div', { class: 'ed-dialog-head' }, h('h2', { text: 'Draft' }), h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'))),
    item('New proposal', 'file-text', () => { if (window.confirm('Start a new proposal? This replaces the draft in this browser.')) load(newProposal(), 'New proposal started'); }),
    item('Load the demo proposal', 'book-open', async () => {
      if (!window.confirm('Load the demo (fictional client)? This replaces the draft in this browser.')) return;
      const res = await fetch('/fixtures/demo-proposal.json', { cache: 'no-store' });
      load(await res.json(), 'Demo proposal loaded');
    }),
    item('Import a config (.json)', 'upload', importJson),
    item('Export this draft (.json)', 'download', exportJson),
    h('p', { class: 'ed-hint', text: 'Duplicating a proposal and starting a new revision arrive with the archive in Phase 3.' }),
  );
  dlg.addEventListener('close', () => dlg.remove());
  D.body.append(dlg);
  dlg.showModal();
}

function buildShell() {
  const drawer = h('aside', { id: 'ed', class: 'ed', 'aria-label': 'Proposal editor' },
    h('div', { class: 'ed-top' },
      h('div', { class: 'ed-brand' }, h('img', { src: BRAND.logoGold, alt: BRAND.name, width: 72, height: 28 }), h('span', { text: 'Editor' })),
      h('div', { class: 'ed-top-actions' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: menu }, icon('menu'), h('span', { text: 'Draft' })),
        h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'ed-check', onclick: () => openChecklist(ctx) }, icon('file-check'), h('span', { text: 'Checklist' }), h('span', { class: 'ed-count-pill', id: 'ed-check-count' })))),
    h('p', { class: 'ed-saved', id: 'ed-saved', role: 'status', 'aria-live': 'polite', text: 'Draft in this browser' }),
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
  const saved = loadDraft();
  state.cfg = normaliseLayout(saved ? saved.cfg : newProposal());
  buildShell();
  renderDrawer();
  applyConfig(await previewMedia(state.cfg));
  initEffects(D);
  ROOT.classList.add('ready');
  if (saved) {
    const t = new Date(saved.savedAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    D.getElementById('ed-saved').textContent = `Saved ${t} · this browser`;
  }
  window.addEventListener('beforeunload', () => saver.flush());
  D.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saver.touch(); saver.flush(); announce('Saved'); }
  });
  window.__editor = { ctx, state, load, newProposal, clearDraft };
}

boot();

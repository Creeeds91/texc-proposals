/**
 * A sent revision, as staff see it (Phase 9): /staff/revision/<id>, served
 * behind sign-in by api/revision-view.js.
 *
 * The page is the client page; this replaces the gate. It asks /api/archive
 * for the revision's own published text (no passphrase: staff are signed in,
 * and the text was never anything but this), signs its photographs, and
 * renders it with the same runtime the client had. A strip above the page
 * says which revision it is and what has happened to it since.
 *
 * Nothing is recorded as the client's: no open, no event, no option. The
 * acceptance shows what was accepted, and the forms say they send nothing.
 * Documents open through the staff link, from that revision's own snapshot.
 *
 * window.revisionReady resolves once the page has drawn; the Archive page
 * waits on it before it copies the page into a record pack.
 */
import { applyConfig, initEffects, whenImagesReady, setHooks, setAcceptance } from './proposal.js';
import { h, icon, apiFor } from './staff-ui.js';

const D = document;
const ROOT = D.documentElement;
const id = (location.pathname.match(/^\/staff\/revision\/([0-9a-f-]{36})\/?$/) || [])[1] || '';
const api = apiFor(id ? `/staff/revision/${id}` : '/archive');
const dayTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Hobart', day: 'numeric', month: 'long', year: 'numeric' });
const at = (iso) => (iso ? dayTime.format(new Date(iso)) : '');
const on = (iso) => (iso ? day.format(new Date(iso)) : '');

let ready;
window.revisionReady = new Promise((done) => { ready = done; });

function withMedia(cfg, media) {
  if (!cfg.media) return cfg;
  return { ...cfg, media: Object.fromEntries(Object.keys(cfg.media).map((k) => [k, media && media[k] ? media[k] : {}])) };
}

/** What happened to this revision since it was sent, in one line each. */
function stateLines(f) {
  const lines = [];
  lines.push(`Sent ${at(f.publishedAt)}${f.publishedBy ? ` by ${f.publishedBy}` : ''}.`);
  if (f.acceptance) lines.push(`${f.acceptance.kind === 'staff' ? 'Acceptance recorded by staff' : 'Accepted'} ${at(f.acceptance.acceptedAt)} by ${[f.acceptance.name, f.acceptance.company].filter(Boolean).join(', ')}.`);
  if (f.withdrawnAt) lines.push(`Withdrawn ${on(f.withdrawnAt)}.`);
  else if (f.supersededAt) lines.push(`Superseded by a later revision ${on(f.supersededAt)}.`);
  else if (f.current) lines.push('This is the current revision.');
  if (f.archivedAt) lines.push(`The proposal was archived ${on(f.archivedAt)}.`);
  return lines;
}

function strip(f) {
  const host = D.getElementById('staff-strip');
  if (!host) return;
  const tpl = Number(ROOT.dataset.tpl);
  const drift = Number.isInteger(f.templateVersion) && f.templateVersion !== tpl;
  host.replaceChildren(h('div', { class: 'wrap staff-strip-in' },
    h('p', { class: 'staff-strip-what' }, icon('archive'),
      h('span', {}, h('strong', { text: `Staff view: ${f.reference || 'proposal'}, revision ${f.rev}, as it was sent` }), ' ', h('span', { text: stateLines(f).join(' ') }))),
    drift ? h('p', { class: 'staff-strip-warn', role: 'note' }, icon('alert-triangle'),
      h('span', { text: `This revision was sent with design version ${f.templateVersion}; this page draws design version ${tpl}, so it may not look exactly as sent. Its exact published text is in the record pack.` })) : null,
    h('p', { class: 'staff-strip-links' },
      h('a', { href: `/archive?proposal=${encodeURIComponent(f.proposalId)}`, text: 'Back to the archive' }),
      f.acceptance ? h('a', { href: `/staff/acceptance/${encodeURIComponent(f.acceptance.id)}`, target: '_blank', rel: 'noopener', text: 'Acceptance record' }) : null)));
  host.hidden = false;
}

function failed(text) {
  const host = D.getElementById('staff-strip');
  if (host) {
    host.replaceChildren(h('div', { class: 'wrap staff-strip-in' }, h('p', { class: 'staff-strip-warn', role: 'alert' }, icon('alert-triangle'), h('span', { text })),
      h('p', { class: 'staff-strip-links' }, h('a', { href: '/archive', text: 'Back to the archive' }))));
    host.hidden = false;
  }
  ROOT.classList.add('ready', 'failed');
  ready(false);
}

async function boot() {
  ROOT.classList.add('js');
  if (!id) { failed('That is not a revision address.'); return; }
  const r = await api('POST', '/api/archive', { action: 'revision', id });
  if (!r.ok || !r.json || !r.json.config) { failed(r.status === 404 ? 'No such revision.' : 'The revision could not be loaded. Reload to try again.'); return; }
  const { config: cfg, media, facts } = r.json;
  setHooks({
    previewNote: 'Staff view of a sent revision: nothing is sent from this page.',
    attachment: async (card, { download = false } = {}) => {
      const f = await api('POST', '/api/archive', { action: 'file', revision: facts.revisionId, card, download });
      if (f.ok && f.json && f.json.url) return f.json;
      throw Object.assign(new Error(String(f.status)), { userMessage: (f.json && f.json.error) || 'The document could not be fetched. Try again.' });
    },
  });
  strip(facts);
  applyConfig(withMedia(cfg, media));
  setAcceptance(facts.acceptance ? { accepted: facts.acceptance } : null);
  D.title = `${facts.reference || 'Proposal'} rev ${facts.rev} (as sent) · staff`;
  await whenImagesReady(D.getElementById('cover') || D, 2500);
  initEffects(D);
  ROOT.classList.add('ready');
  ready(true);
}

boot();

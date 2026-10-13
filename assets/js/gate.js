/**
 * The gate: opens a client's proposal in their browser.
 *
 *   1. fetch the encrypted revision for this link (/api/proposal)
 *   2. derive a key from the passphrase (PBKDF2-SHA256, 600,000 rounds) and
 *      unwrap the revision's content key; a wrong passphrase fails here
 *   3. decrypt, HASH THE BYTES (before parsing — that hash is what acceptance
 *      will prove was read, Phase 5), parse, show
 *   4. tell the server it was opened (/api/view, with the view token sealed
 *      inside the proposal, so a link alone cannot fake an open)
 *
 * Nothing is stored: the passphrase lives in this tab's memory only, so moving
 * between revisions does not ask again but closing the tab forgets it.
 * Decryption is assets/js/envelope-client.js, the other half of lib/envelope.js;
 * `check.mjs envelope` proves the two agree.
 */
import { applyConfig, initEffects, whenImagesReady, setHooks, setAcceptance } from './proposal.js';
import { openEnvelope as open, supported } from './envelope-client.js';

const D = document;
const ROOT = D.documentElement;

const slug = (location.pathname.match(/^\/p\/([a-z0-9]{10})\/?$/) || [])[1] || '';
const params = new URLSearchParams(location.search);
const token = /^[a-f0-9]{64}$/.test(params.get('t') || '') ? params.get('t') : '';
const session = (window.crypto.randomUUID ? window.crypto.randomUUID() : String(Math.random()).slice(2)).replace(/[^a-z0-9-]/gi, '');

const state = { passphrase: '', rev: '', vt: '', mediaAt: 0, media: null, cfg: null, plaintextSha256: '' };

function show(which, text) {
  const gate = D.getElementById('gate');
  gate.hidden = false;
  for (const card of gate.querySelectorAll('[data-gate]')) card.hidden = card.dataset.gate !== which;
  if (which === 'wait' && text) gate.querySelector('[data-gate-wait]').textContent = text;
  if (which === 'form') setTimeout(() => D.getElementById('gate-pass').focus(), 30);
}

async function fetchRevision(rev) {
  const q = new URLSearchParams({ slug, t: token });
  if (rev) q.set('rev', rev);
  const r = await fetch(`/api/proposal?${q}`, { cache: 'no-store', credentials: 'omit' });
  if (r.status === 429) return { wait: true };
  if (!r.ok) return null;
  return r.json();
}

const post = (path, payload, keepalive = false) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', keepalive,
  body: JSON.stringify({ slug, t: token, vt: state.vt, rev: state.rev, session, ...payload }),
});

async function signedMedia() {
  if (!state.cfg || !state.cfg.media) return null;
  try {
    const r = await post('/api/media', {});
    if (!r.ok) return null;
    state.mediaAt = Date.now();
    return (await r.json()).media || {};
  } catch { return null; }
}

function withMedia(cfg, media) {
  if (!cfg.media) return cfg;
  return { ...cfg, media: Object.fromEntries(Object.keys(cfg.media).map((id) => [id, media && media[id] ? media[id] : {}])) };
}

function revisionLinks(data) {
  const box = D.querySelector('[data-revisions]');
  const links = D.querySelector('[data-revision-links]');
  if (!box || !links) return;
  links.replaceChildren();
  box.hidden = data.revisions.length < 2;
  data.revisions.forEach((label, i) => {
    if (i) links.append(' · ');
    if (label === data.rev) {
      const b = D.createElement('strong');
      b.textContent = `Rev ${label}${label === data.current ? ' (current)' : ''}`;
      links.append(b);
    } else {
      const a = D.createElement('a');
      a.href = `/p/${slug}?t=${token}${label === data.current ? '' : `&rev=${label}`}`;
      a.textContent = `Rev ${label}${label === data.current ? ' (current)' : ''}`;
      a.addEventListener('click', (e) => { e.preventDefault(); switchTo(label === data.current ? '' : label, a.href); });
      links.append(a);
    }
  });
}

async function present(data, opened) {
  const cfg = JSON.parse(new TextDecoder().decode(opened.bytes));
  state.vt = typeof cfg.__vt === 'string' ? cfg.__vt : '';
  delete cfg.__vt;
  state.rev = data.rev;
  state.plaintextSha256 = opened.sha;
  cfg.meta = cfg.meta || {};
  if (data.rev !== data.current) {
    cfg.meta.supersededBy = data.current;
    cfg.meta.currentHref = `/p/${slug}?t=${token}`;
    cfg.meta.status = 'superseded';
  }
  state.cfg = cfg;
  const media = await Promise.race([signedMedia(), new Promise((d) => setTimeout(() => d(null), 2500))]);
  state.media = media;
  setAcceptance(null);
  applyConfig(withMedia(cfg, media));
  if (cfg.media && !media) signedMedia().then((m) => { if (m) { state.media = m; applyConfig(withMedia(cfg, m)); } });
  acceptanceStatus().then((st) => { if (st) setAcceptance(st); });
  revisionLinks(data);
  D.getElementById('gate').hidden = true;
  ROOT.classList.add('unlocked');
  await whenImagesReady(D.getElementById('cover') || D, 1500);
  initEffects(D);
  ROOT.classList.add('ready');
  post('/api/view', {}, true).catch(() => {});
}

/** Is this revision accepted, can it be, was an earlier one? (After unlocking: it needs the view token.) */
async function acceptanceStatus() {
  try {
    const r = await post('/api/accept', { action: 'status' });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

/** POST, answering { status, json } whatever happens, so the page can say what went wrong. */
async function send(path, payload) {
  const r = await post(path, payload);
  let json = {};
  try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}

async function switchTo(rev, href) {
  show('wait', 'Opening the revision…');
  const data = await fetchRevision(rev);
  if (!data || data.wait) { show('gone'); return; }
  try {
    const opened = await open(data, state.passphrase);
    history.pushState(null, '', href);
    window.scrollTo({ top: 0, behavior: 'instant' });
    await present(data, opened);
  } catch { show('form'); }
}

async function boot() {
  ROOT.classList.add('js');
  if (!slug || !token || !supported()) { show('gone'); return; }
  show('wait', 'Loading…');
  const data = await fetchRevision(params.get('rev') || '');
  if (!data) { show('gone'); return; }
  if (data.wait) { show('wait', 'Too many attempts from this connection. Wait a minute, then reload the page.'); return; }
  show('form');

  const form = D.getElementById('gate-form');
  const input = D.getElementById('gate-pass');
  const msg = D.getElementById('gate-msg');
  const go = D.getElementById('gate-go');
  D.getElementById('gate-show').addEventListener('change', (e) => { input.type = e.target.checked ? 'text' : 'password'; });
  let tries = 0;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = input.value.trim().toLowerCase();
    if (!pass) { msg.textContent = 'Type the passphrase you were given.'; input.focus(); return; }
    go.disabled = true;
    go.textContent = 'Opening…';
    msg.textContent = '';
    try {
      const opened = await open(data, pass);
      state.passphrase = pass;
      input.value = '';
      await present(data, opened);
    } catch (err) {
      tries += 1;
      msg.textContent = err.passphrase
        ? (tries >= 3 ? 'That passphrase does not open this proposal. Check it word by word, or call the number below.' : 'That passphrase does not open this proposal. Check it and try again.')
        : 'This proposal could not be opened in this browser. Try an up-to-date browser, or call the number below.';
      input.select();
    } finally {
      go.disabled = false;
      go.textContent = 'Open the proposal';
    }
  });

  window.addEventListener('popstate', () => location.reload());
  D.addEventListener('proposal:option', (e) => { post('/api/event', { event: 'option_toggled', meta: e.detail }).catch(() => {}); });
  window.addEventListener('beforeprint', () => { post('/api/event', { event: 'printed' }, true).catch(() => {}); });
  // Photograph links last an hour; refresh them before printing if they are close to expiry.
  setHooks({
    issued: true,
    beforePrint: async () => {
      if (!state.cfg || !state.cfg.media || Date.now() - state.mediaAt < 45 * 60000) return;
      const m = await signedMedia();
      if (m) { state.media = m; applyConfig(withMedia(state.cfg, m)); }
    },
    // Acceptance: the server checks the fingerprint of the exact bytes this page decrypted.
    accept: (payload) => send('/api/accept', { action: 'accept', plaintextSha256: state.plaintextSha256, ...payload }),
    requestChanges: (payload) => send('/api/changes', payload),
    // A document: a fresh 60-second link for each open or download (the server records which).
    attachment: async (id, { download = false } = {}) => {
      const r = await post('/api/attachment', { id, download });
      if (r.ok) return r.json();
      const userMessage = r.status === 429 ? 'Too many requests just now. Wait a minute and try again.'
        : r.status === 410 ? 'This document is no longer available from this link.' : 'The document could not be fetched. Try again.';
      throw Object.assign(new Error(String(r.status)), { userMessage });
    },
  });
}

window.proposalFingerprint = () => state.plaintextSha256;
boot();

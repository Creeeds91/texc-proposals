/**
 * The Phase 3 check suites: everything that needs the database, the API or
 * the whole app running. Registered in scripts/check.mjs.
 *
 *   schema     supabase/schema.sql stands up, locks down and keeps its promises
 *   envelope   server encryption and the browser's decryption agree (Chromium)
 *   refusals   every way a client request can be wrong gets the identical 410;
 *              record-only endpoints answer 204 whatever happened; staff
 *              endpoints refuse strangers and cross-site posts
 *   editor     the editor, driven in Chromium against the real stack
 *   flow       staff to client: sign in, publish, unlock, revise, supersede,
 *              approve a new person — the whole loop in a browser
 *
 * Each needs Postgres 16 and Docker (scripts/lib/local-supabase.mjs) and the
 * browser ones need Playwright; without them a suite reports NOT CHECKED.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSchemaProof } from '../schema-standup-check.mjs';
import { encryptRevision, rewrap } from '../../lib/envelope.js';
import { sha256 } from '../../lib/tokens.js';
import { runChecks } from '../../assets/js/checks.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PASS = 'pass', FAIL = 'fail', SKIP = 'not checked';
const DEMO = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/demo-proposal.json'), 'utf8'));

/* ------------------------------------------------------------ shared */

let appCtx = null;
let appWhyNot = '';
let pwCtx = null;
async function app() {
  if (appCtx !== null) return appCtx;
  try {
    const { startLocalApp, codeFor, SUPER_EMAIL, CHECK_EMAIL } = await import('../demo/local-app.mjs');
    const a = await startLocalApp({ port: 4600 + Math.floor(Math.random() * 300) });
    appCtx = a ? { ...a, codeFor, SUPER_EMAIL, CHECK_EMAIL } : false;
  } catch (e) { appCtx = false; appWhyNot = e.message; }
  return appCtx;
}
async function browser() {
  if (pwCtx !== null) return pwCtx;
  const { loadPlaywright } = await import('./browser.mjs');
  const pw = await loadPlaywright();
  pwCtx = pw ? { pw, browser: await pw.chromium.launch() } : false;
  return pwCtx;
}
export async function closeServerSuites() {
  if (pwCtx) await pwCtx.browser.close();
  if (appCtx) appCtx.stop();
}

/** A tiny API client with its own session cookie. */
function client(a) {
  let cookie = '';
  return {
    async call(method, path, body, headers = {}) {
      const r = await fetch(a.url + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', origin: a.url, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, text, json, headers: r.headers };
    },
    async signIn(email) {
      await this.call('POST', '/api/auth?action=code', { email });
      const code = a.codeFor(a.outbox(), email);
      return this.call('POST', '/api/auth?action=verify', { email, code });
    },
    cookie: () => cookie,
  };
}

/** A demo proposal, created, with every acknowledgement given; optionally published. */
async function demoProposal(c, { publish = true, mutate } = {}) {
  const cfg = JSON.parse(JSON.stringify(DEMO));
  if (mutate) mutate(cfg);
  const { checkContext } = await import('../../lib/proposals.js');
  const created = await c.call('POST', '/api/proposals', { action: 'create', config: cfg });
  const id = created.json.id;
  const draft = await c.call('GET', `/api/drafts?id=${id}`);
  const acks = runChecks(draft.json.config, checkContext()).acks.map((x) => x.key);
  const put = await c.call('PUT', '/api/drafts', { id, version: draft.json.version, config: { ...draft.json.config, acks } });
  if (!publish) return { id, version: put.json.version };
  const pub = await c.call('POST', '/api/proposals', { action: 'publish', id, version: put.json.version });
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.text}`);
  const u = new URL(pub.json.url);
  return { id, version: put.json.version, url: pub.json.url, slug: u.pathname.split('/')[2], t: u.searchParams.get('t'), passphrase: pub.json.passphrase };
}

const skipNoStack = () => ({ status: SKIP, detail: [`the local stack could not start (Postgres 16 and Docker)${appWhyNot ? `: ${appWhyNot}` : ''}`] });

/* ------------------------------------------------------------ schema */

export async function suiteSchema() {
  const out = await runSchemaProof();
  if (!out.ran) return { status: SKIP, detail: [out.reason] };
  const failed = out.results.filter((r) => !r.ok);
  return failed.length
    ? { status: FAIL, detail: failed.map((r) => `${r.label} → ${JSON.stringify(r.got)}`) }
    : { status: PASS, detail: [`all ${out.results.length} promises held on a fresh Postgres 16 + PostgREST`, 'anon refused every table and function; revisions immutable; logs append-only; publish/rotate races refused'] };
}

/* ------------------------------------------------------------ envelope */

export async function suiteEnvelope({ browserSession }) {
  const ctx = await browserSession();
  if (!ctx) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const text = JSON.stringify({ meta: { project: 'Rock removal — Stage 2 · 50 m from “the shed”' }, n: [1, 2, 3], unicode: 'Ōtautahi ✓' });
  const bytes = new TextEncoder().encode(text);
  const pass = 'harbour-lantern-copper-marsh-quartz-482';
  const { enc, key } = await encryptRevision(bytes, pass);
  const rewrapped = await rewrap(key, pass, 'new-words-here-and-there-001');
  const env = JSON.parse(enc);
  const tampered = JSON.stringify({ ...env, ct: Buffer.from(Buffer.from(env.ct, 'base64').map((b, i) => (i === 5 ? b ^ 1 : b))).toString('base64') });
  const page = await ctx.browser.newPage();
  await page.goto(`${ctx.base}/demo`);
  const r = await page.evaluate(async ({ enc, key, rewrapped, tampered, pass }) => {
    const { openEnvelope } = await import('/assets/js/envelope-client.js');
    const out = {};
    const o = await openEnvelope({ enc, key }, pass);
    out.text = new TextDecoder().decode(o.bytes); out.sha = o.sha;
    out.wrong = await openEnvelope({ enc, key }, pass + 'x').then(() => 'OPENED', (e) => (e.passphrase ? 'passphrase' : 'other'));
    out.newPass = await openEnvelope({ enc, key: rewrapped }, 'new-words-here-and-there-001').then((x) => new TextDecoder().decode(x.bytes), () => 'FAILED');
    out.oldPassOnNew = await openEnvelope({ enc, key: rewrapped }, pass).then(() => 'OPENED', (e) => (e.passphrase ? 'passphrase' : 'other'));
    out.tampered = await openEnvelope({ enc: tampered, key }, pass).then(() => 'OPENED', (e) => (e.passphrase ? 'passphrase' : 'refused'));
    return out;
  }, { enc, key, rewrapped, tampered, pass });
  await page.close();
  if (r.text !== text) fails.push('the browser did not recover the exact plaintext');
  if (r.sha !== sha256(bytes)) fails.push('the browser hash of the plaintext differs from the server\'s (acceptance would never match)');
  if (r.wrong !== 'passphrase') fails.push(`a wrong passphrase gave "${r.wrong}"`);
  if (r.newPass !== text) fails.push('after rotation the new passphrase did not open the unchanged ciphertext');
  if (r.oldPassOnNew !== 'passphrase') fails.push('after rotation the old passphrase still opened it');
  if (r.tampered !== 'refused') fails.push(`altered ciphertext gave "${r.tampered}" (it must be refused, not opened)`);
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: ['encrypted in Node, opened in Chromium with the gate\'s own module: exact bytes, same SHA-256', 'wrong passphrase refused; rotation re-wraps without touching the ciphertext; tampering refused'] };
}

/* ------------------------------------------------------------ refusals */

export async function suiteRefusals() {
  const a = await app();
  if (!a) return skipNoStack();
  const fails = [];
  const staff = client(a);
  await staff.signIn(a.CHECK_EMAIL);
  const live = await demoProposal(staff);
  const withdrawn = await demoProposal(staff);
  await staff.call('POST', '/api/proposals', { action: 'withdraw', id: withdrawn.id, note: 'check' });
  const expired = await demoProposal(staff);
  const { psql } = await import('./local-supabase.mjs');
  psql(a.sb.conn, `update public.texc_proposals set link_expires_at = now() - interval '1 minute' where id = '${expired.id}'`);
  const unissued = await demoProposal(staff, { publish: false });
  const unissuedSlug = (await staff.call('GET', `/api/proposals?id=${unissued.id}`)).json.slug;
  const rotated = await demoProposal(staff);
  await staff.call('POST', '/api/proposals', { action: 'rotate', id: rotated.id });

  const zero = '0'.repeat(64);
  const cases = [
    ['wrong token', live.slug, zero, ''],
    ['wrong slug', 'abcdefghij', live.t, ''],
    ['no such revision', live.slug, live.t, 'Q'],
    ['withdrawn', withdrawn.slug, withdrawn.t, ''],
    ['link expired', expired.slug, expired.t, ''],
    ['never issued', unissuedSlug, zero, ''],
    ['link rotated (old token)', rotated.slug, rotated.t, ''],
    ['malformed token', live.slug, 'nothex', ''],
    ['malformed slug', '../../etc', live.t, ''],
  ];
  const anon = client(a);
  const goodGet = await anon.call('GET', `/api/proposal?slug=${live.slug}&t=${live.t}`);
  if (goodGet.status !== 200) fails.push(`the live link itself did not open (${goodGet.status})`);
  let reference = null;
  for (const [name, slug, t, rev] of cases) {
    const q = new URLSearchParams({ slug, t, ...(rev ? { rev } : {}) });
    const g = await anon.call('GET', `/api/proposal?${q}`);
    const m = await anon.call('POST', '/api/media', { slug, t, vt: zero, rev });
    const sig = `${g.status}|${g.headers.get('content-type')}|${g.headers.get('cache-control')}|${g.text}`;
    if (reference === null) reference = sig;
    if (sig !== reference) fails.push(`${name}: GET /api/proposal answered differently: ${sig}`);
    if (`${m.status}|${m.text}` !== `410|${g.text}`) fails.push(`${name}: POST /api/media answered ${m.status} ${m.text}`);
  }
  if (!reference || !reference.startsWith('410|')) fails.push(`refusals are not 410: ${reference}`);
  // A right link with a wrong view token: media is still refused, identically.
  const wrongVt = await anon.call('POST', '/api/media', { slug: live.slug, t: live.t, vt: zero });
  if (`${wrongVt.status}|${wrongVt.text}` !== `410|${reference.split('|').slice(3).join('|')}`) fails.push(`a wrong view token got ${wrongVt.status} ${wrongVt.text}`);
  // Record-only endpoints: 204 and nothing else, whatever was sent.
  for (const path of ['/api/view', '/api/event']) {
    for (const payload of [{ slug: live.slug, t: live.t, vt: zero, event: 'printed' }, { slug: 'nope', t: 'nope' }, {}]) {
      const r = await anon.call('POST', path, payload);
      if (r.status !== 204 || r.text !== '') fails.push(`${path} answered ${r.status} "${r.text}" to ${JSON.stringify(payload).slice(0, 60)}`);
    }
  }
  // Staff endpoints: no session, cross-site, wrong method.
  for (const [method, path] of [['GET', '/api/proposals'], ['GET', '/api/drafts?id=' + live.id], ['POST', '/api/proposals'], ['GET', '/api/people'], ['POST', '/api/staff-media']]) {
    const r = await anon.call(method, path, method === 'POST' ? { action: 'create' } : undefined);
    if (r.status !== 401) fails.push(`${method} ${path} without a session answered ${r.status}`);
  }
  const page = await anon.call('GET', '/editor');
  if (page.status !== 302 || !/^\/signin\?next=/.test(page.headers.get('location') || '')) fails.push(`/editor without a session answered ${page.status} ${page.headers.get('location')}`);
  const xs = await staff.call('POST', '/api/proposals', { action: 'create', config: {} }, { origin: 'https://evil.example' });
  if (xs.status !== 403) fails.push(`a cross-site POST with a valid session answered ${xs.status}`);
  const ok = await staff.call('GET', `/api/drafts?id=${live.id}`);
  if (ok.status !== 200) fails.push('the staff session itself stopped working');
  // A CONFIRM in a visible section is refused at publish, and nothing is written.
  const pending = await demoProposal(staff, { publish: false, mutate: (cfg) => { cfg.letter.greetingName = { $confirm: 'first name to confirm' }; } });
  const d0 = (await staff.call('GET', `/api/drafts?id=${pending.id}`)).json;
  const refused = await staff.call('POST', '/api/proposals', { action: 'publish', id: pending.id, version: d0.version });
  const after = (await staff.call('GET', `/api/proposals?id=${pending.id}`)).json;
  if (refused.status !== 422 || after.revisions.length !== 0 || after.reference) fails.push(`publishing a draft with a CONFIRM answered ${refused.status} and left ${after.revisions.length} revision(s), reference ${after.reference}`);
  // A stale draft version is refused too: what is published is what the editor saw.
  const stale = await staff.call('POST', '/api/proposals', { action: 'publish', id: live.id, version: 1 });
  if (stale.status !== 409) fails.push(`publishing from a stale draft version answered ${stale.status}`);
  // A viewer cannot edit or publish.
  const viewerEmail = 'viewer.check@example.com';
  await anon.call('POST', '/api/auth?action=code', { email: viewerEmail });
  await staff.call('POST', '/api/people', { email: viewerEmail, status: 'active', role: 'viewer' });
  const viewer = client(a);
  await viewer.signIn(viewerEmail);
  const vr = await viewer.call('GET', '/api/proposals');
  if (vr.status !== 403) fails.push(`a viewer listing proposals for editing answered ${vr.status}`);
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [
    `${cases.length} kinds of bad link (wrong token, withdrawn, expired, rotated, never issued…) get byte-identical 410s from /api/proposal and /api/media`,
    'view and event answer 204 with no body, whatever is sent; staff endpoints answer 401 without a session',
    'publishing a CONFIRM is refused (422) with nothing written; a stale draft version is refused (409)',
    'cross-site POST refused with a valid session; a viewer cannot open proposals for editing',
  ] };
}

/* ------------------------------------------------------------ browser helpers */

// Signed in through the real sign-in page once; later contexts reuse that session.
let staffState = null;
async function signedInContext(a, b, { width = 1440, height = 900, scale = 1 } = {}) {
  const ctx = await b.browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', ...(staffState ? { storageState: staffState } : {}) });
  const page = await ctx.newPage();
  const problems = [];
  // A 410 (a dead link) and a 409 (the deliberate two-editor conflict) are expected responses, not faults.
  page.on('console', (m) => { if ((m.type() === 'error' && !/status of 4(10|09)/.test(m.text())) || /Content Security Policy/i.test(m.text())) problems.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => problems.push('script error: ' + e.message));
  page.on('dialog', (d) => d.accept());
  if (staffState) {
    await page.goto(`${a.url}/editor`);
    return { ctx, page, problems };
  }
  await page.goto(`${a.url}/signin?next=/editor`);
  await page.fill('#email', a.SUPER_EMAIL);
  await page.click('#email-form button');
  await page.waitForSelector('[data-step="code"]:not([hidden])');
  await page.fill('#code', a.codeFor(a.outbox(), a.SUPER_EMAIL));
  await page.click('#code-form button');
  await page.waitForURL((u) => new URL(u).pathname === '/editor');
  staffState = await ctx.storageState();
  return { ctx, page, problems };
}

async function createFromDemo(page) {
  return page.evaluate(async () => {
    const f = await (await fetch('/api/editor?fixture=demo')).json();
    const r = await fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', config: f }) });
    const j = await r.json();
    if (!j.id) throw new Error(`create answered ${r.status}: ${JSON.stringify(j)}`);
    return j.id;
  });
}

/* ------------------------------------------------------------ editor */

export async function suiteEditor() {
  const a = await app();
  if (!a) return skipNoStack();
  const b = await browser();
  if (!b) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { ctx, page, problems } = await signedInContext(a, b);
  const id = await createFromDemo(page);
  await page.goto(`${a.url}/editor/${id}`);
  await page.waitForFunction(() => window.__editor && document.querySelectorAll('.ed-panel').length === 20, null, { timeout: 15000 });
  const cfg = () => page.evaluate(() => window.__editor.state.cfg);
  const blockers = () => page.evaluate(() => window.__editor.state.checks.blockers.map((x) => x.message));
  const settle = () => page.waitForTimeout(350);
  await settle();

  await page.fill('[data-path="meta.project"] input', 'Controlled rock removal, Stage 3');
  await settle();
  expect(await page.textContent('.cover-title span') === 'Controlled rock removal, Stage 3', 'typing the project did not update the cover');

  await page.click('.ed-panel[data-sec="about"] .ed-switch');
  await settle();
  expect(await page.evaluate(() => document.getElementById('about').hidden), 'the show/hide switch did not reach the page');
  await page.focus('.ed-panel[data-sec="site"] .ed-handle');
  await page.keyboard.press('Alt+ArrowUp');
  await settle();
  const order = (await cfg()).layout.sections.map((x) => x.id);
  expect(order.indexOf('site') < order.indexOf('scope') && order[0] === 'cover' && order.at(-1) === 'contact', 'Alt+Up did not reorder (or moved a pinned section)');

  await page.click('.ed-panel[data-sec="risk"] .ed-panel-toggle');
  await settle();
  const n0 = (await cfg()).risk.hazards.length;
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] .ed-row .ed-danger >> nth=0');
  await settle();
  await page.click('#ed-toast button');
  await settle();
  expect((await cfg()).risk.hazards.length === n0, 'delete then Undo did not restore the hazard');
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] > .ed-rows-tools > button >> nth=0');
  await settle();
  expect((await blockers()).some((m) => /Hazard \d+ is empty/.test(m)), 'an empty hazard row did not block publishing');
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] .ed-row .ed-danger >> nth=-1');
  await settle();

  await page.click('.ed-panel[data-sec="letter"] .ed-panel-toggle');
  await settle();
  const greet = '.ed-panel[data-sec="letter"] [data-path="letter.greetingName"]';
  const before = (await cfg()).letter.greetingName;
  await page.click(`${greet} .ed-flag`);
  await settle();
  expect((await cfg()).letter.greetingName?.suggested === before && await page.isVisible('#letter mark.confirm'), 'CONFIRM lost the text or did not show in the preview');
  await page.click(`${greet} .ed-linkbtn:has-text("Confirmed")`);
  await settle();
  expect((await cfg()).letter.greetingName === before, '"Confirmed — use this text" did not restore it');

  // Upload a photograph: resized in the browser, stored on the server, previewed.
  await page.click('[data-path="cover.image"] button:has-text("Change")');
  await page.waitForSelector('dialog .ed-photo');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--gold'); g.fillRect(0, 0, 2400, 1600); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ink'); g.fillRect(200, 200, 900, 600); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('dialog input[type=file]', { name: 'stage-3-corridor.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => { const c = window.__editor.state.cfg; const id = c.cover?.image?.id || ''; return /^u-/.test(id) && c.media[id] && !c.media[id].pending; }, null, { timeout: 20000 });
  expect((await blockers()).some((m) => /no alt text/.test(m)), 'a new photograph without alt text did not block publishing');
  await page.fill('[data-path="cover.image"] input >> nth=0', 'Rock face in the Stage 3 corridor');
  await settle();

  // Checklist to Ready, then the autosave holds across a reload.
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  expect(/Ready to publish/.test(await page.textContent('dialog .ed-verdict')) && !(await page.isDisabled('#ck-publish')), 'acknowledging everything did not reach "Ready" with Publish enabled');
  await page.click('dialog .ed-dialog-head button');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 });
  await page.reload();
  await page.waitForFunction(() => window.__editor && window.__editor.state.cfg, null, { timeout: 15000 });
  await settle();
  const after = await cfg();
  expect(after.meta.project === 'Controlled rock removal, Stage 3' && after.acks && after.acks.length > 0, 'the draft did not come back from the server after a reload');
  expect(await page.evaluate(() => document.querySelector('img[data-img="cover.image"]').currentSrc.length > 0), 'the uploaded cover did not show after a reload');

  // Two people at once: the second save is refused, never silently overwritten.
  const ctx2 = await b.browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await ctx.storageState() });
  const page2 = await ctx2.newPage();
  page2.on('dialog', (d) => d.accept());
  await page2.goto(`${a.url}/editor/${id}`);
  await page2.waitForFunction(() => window.__editor && window.__editor.state.cfg, null, { timeout: 15000 });
  await page2.fill('[data-path="meta.project"] input', 'Their version of the title');
  await page2.keyboard.press('Control+s');
  await page2.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 });
  await page.fill('[data-path="meta.project"] input', 'My version of the title');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('dialog:has-text("Someone else saved")', { timeout: 10000 });
  await page.click('dialog button:has-text("Load theirs")');
  await page.waitForFunction(() => window.__editor.state.cfg.meta.project === 'Their version of the title', null, { timeout: 10000 });
  expect(true, '');
  await ctx2.close();

  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('ed')).display === 'none'), 'the drawer shows in print');
  await page.emulateMedia({ media: 'screen' });
  await ctx.close();
  fails.push(...problems);

  // Phone.
  const phone = await signedInContext(a, b, { width: 390, height: 844, scale: 2 });
  await phone.page.goto(`${a.url}/editor/${id}`);
  await phone.page.waitForFunction(() => window.__editor && window.__editor.state.cfg, null, { timeout: 15000 });
  const lay = await phone.page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { drawer: r('#ed').width, overlap: r('.ed-brand').right > r('.ed-top-actions').left + 1, wide: document.getElementById('ed').scrollWidth > window.innerWidth };
  });
  expect(lay.drawer === 390 && !lay.overlap && !lay.wide, `phone layout: drawer ${lay.drawer}px, header overlap ${lay.overlap}, too wide ${lay.wide}`);
  await phone.page.click('#ed-mode-preview');
  expect(await phone.page.evaluate(() => getComputedStyle(document.getElementById('ed')).display === 'none'), 'Preview did not show the page');
  await phone.ctx.close();
  fails.push(...phone.problems);

  return fails.filter(Boolean).length ? { status: FAIL, detail: fails.filter(Boolean) } : { status: PASS, detail: [
    'typing, show/hide, keyboard reorder, rows with undo, CONFIRM flag and restore',
    'upload resized, stored on the server and previewed; new photo blocks without alt; checklist reaches Ready',
    'autosave to the server survives a reload; a colleague\'s save is never silently overwritten; phone layout holds',
  ] };
}

/* ------------------------------------------------------------ flow */

export async function suiteFlow() {
  const a = await app();
  if (!a) return skipNoStack();
  const b = await browser();
  if (!b) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { ctx, page, problems } = await signedInContext(a, b);
  const id = await createFromDemo(page);
  await page.goto(`${a.url}/editor/${id}`);
  await page.waitForFunction(() => window.__editor && window.__editor.state.cfg, null, { timeout: 15000 });
  // A photograph of the site, uploaded: the client must see it too, through a signed link.
  await page.click('[data-path="cover.image"] button:has-text("Change")');
  await page.waitForSelector('dialog .ed-photo');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1800; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--steel-500') || 'gray'; g.fillRect(0, 0, 1800, 1200); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('dialog input[type=file]', { name: 'site-walk.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => { const c = window.__editor.state.cfg; const i = c.cover?.image?.id || ''; return /^u-/.test(i) && c.media[i] && !c.media[i].pending; }, null, { timeout: 20000 });
  await page.fill('[data-path="cover.image"] input >> nth=0', 'The Stage 2 corridor from the north');
  await page.waitForTimeout(400);
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.check('#ck-email');
  const mailBefore = a.outbox().length;
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Published")', { timeout: 30000 });
  const codes = await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent));
  const [link, pass] = codes;
  expect(/\/p\/[a-z0-9]{10}\?t=[a-f0-9]{64}$/.test(link) && /^([a-z]+-){5}\d{3}$/.test(pass || ''), 'publishing did not show a link and a passphrase');
  const sent = a.outbox().slice(mailBefore);
  expect(sent.some((m) => m.subject.startsWith('Proposal:')) && !sent.some((m) => JSON.stringify(m).includes(pass)), 'the link was not emailed, or the email contained the passphrase');
  await page.click('dialog .ed-dialog-head button');

  const cctx = await b.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const cp = await cctx.newPage();
  const cproblems = [];
  cp.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) cproblems.push(m.text().slice(0, 200)); });
  cp.on('pageerror', (e) => cproblems.push('script error: ' + e.message));
  await cp.goto(link);
  await cp.waitForSelector('#gate-form');
  expect(await cp.evaluate(() => getComputedStyle(document.getElementById('main')).display === 'none' && !document.body.innerText.includes('Ashgrove')), 'something of the proposal showed before unlocking');
  await cp.fill('#gate-pass', 'wrong-passphrase-entirely-000');
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.getElementById('gate-msg').textContent.length > 5, null, { timeout: 15000 });
  const t0 = Date.now();
  await cp.fill('#gate-pass', pass);
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.documentElement.classList.contains('unlocked'), null, { timeout: 15000 });
  const unlockMs = Date.now() - t0;
  expect(/^[A-Z]+-P-\d{4}-\d{3}$/.test((await cp.textContent('[data-field="meta.reference"]')).trim()), 'the unlocked page does not show its reference');
  await cp.waitForFunction(() => { const i = document.querySelector('img[data-img="cover.image"]'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 }).catch(() => {});
  const cover = await cp.evaluate(() => { const i = document.querySelector('img[data-img="cover.image"]'); return { src: i.currentSrc, w: i.naturalWidth, alt: i.alt }; });
  expect(/\/storage\/v1\/object\/sign\/texc-media\//.test(cover.src) && cover.w > 0 && cover.alt === 'The Stage 2 corridor from the north', `the uploaded cover did not reach the client through a signed link (${cover.src.slice(0, 80)}, ${cover.w}px)`);
  const fp = await cp.evaluate(() => window.proposalFingerprint());
  expect(/^[a-f0-9]{64}$/.test(fp), 'the plaintext fingerprint was not kept for acceptance');
  await page.waitForTimeout(400);
  const summary = await page.evaluate(async (pid) => (await fetch(`/api/proposals?id=${pid}`)).json(), id);
  expect(summary.openCount === 1 && a.outbox().some((m) => m.subject.startsWith('Opened:')), `the open was not recorded or the office not told (${summary.openCount})`);

  // Revise: same link, Rev B; Rev A still opens, marked superseded.
  await page.fill('[data-path="meta.project"] input', 'Proposed specialist controlled rock removal, Stage 2');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 });
  await page.click('#ed-check');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog .ed-ck')].some((s) => /Changes since/.test(s.textContent) && /Cover/.test(s.textContent)), null, { timeout: 10000 });
  await page.fill('#ck-note', 'Stage 2 named in the title');
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Rev B")', { timeout: 30000 });
  expect(!(await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent))).includes(pass), 'a later revision showed the passphrase again (it should only on first issue)');
  await page.click('dialog .ed-dialog-head button');
  await cp.goto(link);
  await cp.fill('#gate-pass', pass);
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.documentElement.classList.contains('unlocked'), null, { timeout: 15000 });
  expect((await cp.textContent('[data-field="meta.revLabel"]')).includes('B') && /Stage 2/.test(await cp.textContent('.cover-title')), 'the same link did not open Rev B');
  await cp.click('[data-revision-links] a:has-text("Rev A")');
  await cp.waitForFunction(() => !document.getElementById('superseded').hidden, null, { timeout: 15000 });
  expect(!/Stage 2/.test(await cp.textContent('.cover-title')), 'Rev A did not show its own content');

  // Rotate: the old link dies at once.
  page.once('dialog', (d) => d.accept());
  const rot = await page.evaluate(async (pid) => (await fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rotate', id: pid }) })).json(), id);
  const dead = await cctx.newPage();
  await dead.goto(link);
  await dead.waitForSelector('[data-gate="gone"]:not([hidden])', { timeout: 10000 });
  expect(rot.url && rot.url !== link, 'rotation did not issue a new link');
  await dead.close();

  // A new person asks for access, an admin approves, they can sign in.
  const newbie = 'new.estimator@example.com';
  await fetch(`${a.url}/api/auth?action=code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: newbie }) });
  expect(a.outbox().some((m) => m.subject.includes('has asked for access')), 'administrators were not told about the access request');
  await page.click('#ed-menu');
  await page.click('dialog .ed-menu-item:has-text("People")');
  await page.waitForSelector(`dialog .ed-person.is-pending:has-text("${newbie}")`);
  await page.selectOption(`dialog .ed-person:has-text("${newbie}") select`, 'editor');
  await page.waitForTimeout(400);
  await page.click(`dialog .ed-person:has-text("${newbie}") button:has-text("Approve")`);
  await page.waitForSelector(`dialog .ed-person.is-active:has-text("${newbie}")`, { timeout: 10000 });
  expect(a.outbox().some((m) => m.to.includes(newbie) && /you have access/.test(m.subject)), 'the approved person was not emailed');

  await ctx.close();
  await cctx.close();
  fails.push(...problems, ...cproblems);
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [
    `staff sign in, publish from the checklist, link emailed without the passphrase; client unlocks at 390 in ${unlockMs} ms`,
    'an uploaded cover reaches the client through a one-hour signed link from the private bucket',
    'the open is recorded and the office told; Rev B behind the same link; Rev A opens marked superseded',
    'rotation kills the old link at once; an access request reaches admins, is approved, and the person is emailed',
  ] };
}

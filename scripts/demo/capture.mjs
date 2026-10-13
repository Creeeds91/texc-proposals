#!/usr/bin/env node
/**
 * Captures the demo proposal the way a person meets it, for review:
 *
 *   demo-out/1440/NN-<section>.png   every visible section at 1440 wide
 *   demo-out/390/NN-<section>.png    every visible section at 390 wide (2x)
 *   demo-out/1440/00-arrival.png     what loads first, top bar and section rail included
 *   demo-out/390/00-arrival.png      the same on a phone
 *   demo-out/390/00-sections-sheet.png   the phone section index, open
 *   demo-out/1440/quote-option-ticked.png the quotation after ticking the optional item
 *   demo-out/scroll-1440.webm        a scroll-through of the whole page
 *   demo-out/scroll-390.webm         the same on a phone
 *   demo-out/demo-proposal-A4.pdf    the printed proposal
 *   demo-out/editor/*.png            the editor, staff side: desktop and phone   (local stack)
 *   demo-out/phase3/*.png            sign-in, publishing, the gate, revisions, People   (local stack)
 *   demo-out/phase4/*.png            documents: attaching, the check's verdicts, release,
 *                                    the client's documents and viewer            (local stack)
 *   demo-out/phase5/*.png            acceptance: the form, a request for changes, signing and
 *                                    accepting on a phone, the record, the emails, re-acceptance,
 *                                    an acceptance recorded by staff               (local stack)
 *   demo-out/phase6/*.png            the dashboard on a year of fictional proposals: figures, the
 *                                    chart, follow-ups, search, one proposal's history, archive
 *                                    and restore, a viewer's view; a scroll video and a CSV export
 *                                    (local stack)
 *
 *   node scripts/demo/capture.mjs              everything
 *   node scripts/demo/capture.mjs --editor     the editor captures only
 *   node scripts/demo/capture.mjs --phase3     the Phase 3 captures only
 *   node scripts/demo/capture.mjs --phase4     the Phase 4 captures only
 *   node scripts/demo/capture.mjs --phase5     the Phase 5 captures only
 *   node scripts/demo/capture.mjs --phase6     the Phase 6 captures only
 *
 * Section stills hide the fixed furniture (top bar, rail, back-to-top) so a
 * sticky bar is never stitched into the middle of a section; the arrival shots
 * keep it. Look at every capture before sending it.
 * Exit 2 when no browser could be started.
 */
import { mkdirSync, renameSync, rmSync, readdirSync, readFileSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { loadPlaywright } from '../lib/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'demo-out');
const pw = await loadPlaywright();
if (!pw) { console.error('NOT RUN — Playwright not found'); process.exit(2); }

const PORT = 4321;
const server = await startServer({ port: PORT });
const URL = `http://127.0.0.1:${PORT}/demo`;
// Date fields follow the browser's own language, which follows the environment.
const browser = await pw.chromium.launch({ args: ['--lang=en-AU'], env: { ...process.env, LANG: 'en_AU.UTF-8', LANGUAGE: 'en_AU', LC_ALL: 'en_AU.UTF-8' } });

// As TEXC's staff and clients meet it: an Australian locale and Hobart time.
const AU = { locale: 'en-AU', timezoneId: 'Australia/Hobart' };

const hideFurniture = (page, hide) => page.evaluate((h) => {
  for (const id of ['topbar', 'index', 'flt', 'pbar']) {
    const el = document.getElementById(id);
    if (el) el.style.visibility = h ? 'hidden' : '';
  }
}, hide);

async function ready(page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.classList.contains('ready'));
  // Load every image now, so no section is captured with a gap.
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
    await window.whenImagesReady(document, 8000);
  });
}

async function stills(width, height, scale) {
  const dir = resolve(OUT, String(width));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ ...AU, viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  await ready(page);
  await page.screenshot({ path: resolve(dir, '00-arrival.png') });

  const ids = await page.$$eval('#main > [data-sec]:not([hidden])', (els) => els.map((e) => [e.id, e.dataset.num]));
  await hideFurniture(page, true);
  for (const [id, num] of ids) {
    const box = await page.$eval('#' + id, (el) => { const r = el.getBoundingClientRect(); return { x: 0, y: r.top + window.scrollY, width: document.documentElement.clientWidth, height: r.height }; });
    await page.screenshot({ path: resolve(dir, `${num}-${id}.png`), fullPage: true, clip: box });
  }
  await hideFurniture(page, false);

  if (width >= 900) {
    // The quotation after a client ticks the optional item: total and acceptance update.
    await page.click('[data-option]', { force: true });
    await page.evaluate(() => {
      const head = document.querySelector('#quote .sec-head');
      window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY - 110);
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(dir, 'quote-option-ticked.png') });
    await page.click('[data-option]', { force: true });
  } else {
    await page.evaluate(() => window.scrollTo(0, document.getElementById('scope').offsetTop + 200));
    await page.waitForTimeout(300);
    await page.click('#index-toggle');
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(dir, '00-sections-sheet.png') });
  }
  await page.close();
  return ids.length;
}

async function video(width, height, scale) {
  const vdir = resolve(OUT, 'video-tmp');
  rmSync(vdir, { recursive: true, force: true });
  const ctx = await browser.newContext({ ...AU, viewport: { width, height }, deviceScaleFactor: scale, recordVideo: { dir: vdir, size: { width, height } } });
  const page = await ctx.newPage();
  await ready(page);
  await page.waitForTimeout(1200);
  const total = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  const step = width >= 900 ? 9 : 7;
  // A steady scroll, the way someone reads it: about one screen every two seconds.
  for (let y = 0; y < total; y += step * 4) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(16 * 4);
  }
  await page.waitForTimeout(1200);
  await ctx.close();
  const file = readdirSync(vdir).find((f) => f.endsWith('.webm'));
  renameSync(resolve(vdir, file), resolve(OUT, `scroll-${width}.webm`));
  rmSync(vdir, { recursive: true, force: true });
}

/* ------------------------------------------------------------ the editor */

/* ---------------------------------------------- the editor and Phase 3, on the real stack */

let APP = null;
async function localApp() {
  if (APP) return APP;
  const { startLocalApp, codeFor, SUPER_EMAIL } = await import('./local-app.mjs');
  const app = await startLocalApp({ port: 4500 + Math.floor(Math.random() * 300) });
  if (!app) throw new Error('the local stack could not start (Postgres 16 and Docker)');
  APP = { ...app, codeFor, SUPER_EMAIL };
  return APP;
}

// Sign-in codes are limited to three per address per ten minutes (as in
// production), so a session is reused unless the sign-in screens are being shot.
let staffState = null;
async function signedIn(width, height, scale, { shoot } = {}) {
  const a = await localApp();
  const ctx = await browser.newContext({ ...AU, viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', ...(staffState && !shoot ? { storageState: staffState } : {}) });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  if (staffState && !shoot) {
    await page.goto(`${a.url}/editor`);
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
    return { ctx, page, a };
  }
  await page.goto(`${a.url}/signin?next=/editor`);
  if (shoot) await shoot(page, 'signin');
  await page.fill('#email', 'studio@example.com');
  await page.click('#email-form button');
  await page.waitForSelector('[data-step="code"]:not([hidden])');
  await page.fill('#code', a.codeFor(a.outbox(), a.SUPER_EMAIL));
  if (shoot) await shoot(page, 'signin-code');
  await page.click('#code-form button');
  await page.waitForURL((u) => u.pathname === '/editor');
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  staffState = await ctx.storageState();
  return { ctx, page, a };
}

async function openDemo(page, a) {
  const id = await page.evaluate(async () => {
    const f = await (await fetch('/api/editor?fixture=demo')).json();
    const r = await fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', config: f }) });
    return (await r.json()).id;
  });
  await page.goto(`${a.url}/editor/${id}`);
  await page.waitForFunction(() => window.__editor && window.__editor.state.cfg);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.evaluate(() => window.whenImagesReady(document, 8000));
  await page.waitForTimeout(300);
  return id;
}

/** Open one panel, put `inner` (or the panel) at the top of the drawer, and the section at the top of the page. */
async function focusPanel(page, sec, { inner, preview = sec, previewOffset = 0, drawerOffset = 0 } = {}) {
  await page.evaluate(({ sec, inner, preview, previewOffset, drawerOffset }) => {
    const ed = window.__editor;
    ed.state.open = new Set([sec]);
    ed.ctx.refresh();
    const host = document.getElementById('ed-panels');
    const target = document.querySelector(`.ed-panel[data-sec="${sec}"] ${inner || ''}`.trim());
    host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - 8 - drawerOffset;
    const s = document.getElementById(preview);
    if (s) window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 76 + previewOffset);
  }, { sec, inner: inner || '', preview, previewOffset, drawerOffset });
  await page.evaluate(() => window.whenImagesReady(document, 8000));
  await page.waitForTimeout(250);
}

async function editorStills() {
  const dir = resolve(OUT, 'editor');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: resolve(dir, name) });

  let { ctx, page, a } = await signedIn(1440, 900, 1);
  await openDemo(page, a);
  await shot(page, '1440-02-demo-cover.png');
  await focusPanel(page, 'scope', { inner: '.ed-row' });
  await shot(page, '1440-03-scope-locked-safety-line.png');
  await focusPanel(page, 'risk', { inner: '[data-path="risk.hazards"]', previewOffset: 520 });
  await shot(page, '1440-04-hazards.png');
  await focusPanel(page, 'risk', { inner: '[data-path="risk.hazards"] > .ed-rows-tools', previewOffset: 520 });
  await shot(page, '1440-05-hazard-presets.png');
  await focusPanel(page, 'quote', { inner: '[data-path="quote.lines"]', previewOffset: 180 });
  await shot(page, '1440-06-quotation.png');
  await focusPanel(page, 'understanding', { inner: '[data-path="understanding.callout.lead"]' });
  await page.click('.ed-panel[data-sec="understanding"] [data-path="understanding.callout.lead"] .ed-flag');
  await page.waitForTimeout(150);
  await focusPanel(page, 'understanding', { inner: '[data-path="understanding.callout.lead"]' });
  await page.evaluate(() => document.querySelector('#understanding mark.confirm')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await shot(page, '1440-07-confirm-flag.png');
  await page.click('.ed-panel[data-sec="understanding"] [data-path="understanding.callout.lead"] .ed-linkbtn:has-text("Confirmed")');
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  await page.waitForTimeout(200);
  await shot(page, '1440-08-checklist.png');
  await page.click('dialog .ed-dialog-head button');
  await focusPanel(page, 'cover', { inner: '[data-path="cover.image"]' });
  await page.click('.ed-panel[data-sec="cover"] [data-path="cover.image"] button:has-text("Change")');
  await page.waitForSelector('dialog .ed-photo img');
  await page.evaluate(() => window.whenImagesReady(document.querySelector('dialog'), 8000));
  await page.waitForTimeout(300);
  await shot(page, '1440-09-photo-picker.png');
  await page.keyboard.press('Escape');
  await ctx.close();

  ({ ctx, page, a } = await signedIn(390, 844, 2));
  await openDemo(page, a);
  await shot(page, '390-01-edit.png');
  await focusPanel(page, 'risk', { inner: '[data-path="risk.holdPoints"]' });
  await shot(page, '390-02-hold-points.png');
  await page.click('#ed-mode-preview');
  await page.evaluate(() => window.whenImagesReady(document, 8000));
  await page.waitForTimeout(300);
  await shot(page, '390-03-preview.png');
  await page.click('#ed-mode-edit');
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  await page.waitForTimeout(200);
  await shot(page, '390-04-checklist.png');
  await ctx.close();
  return readdirSync(dir).length;
}

/**
 * Phase 3, in the order people meet it: staff sign in, open the list, publish;
 * the client meets the gate, opens it, sees a later revision and an earlier
 * one; a dead link; an administrator approves a new person.
 */
async function phase3Stills() {
  const dir = resolve(OUT, 'phase3');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: resolve(dir, name) });

  const phoneSignin = await signedIn(390, 844, 2, { shoot: (p, n) => shot(p, `390-${n === 'signin' ? '01-sign-in' : '02-sign-in-code'}.png`) });
  await phoneSignin.ctx.close();
  const { ctx, page, a } = await signedIn(1440, 900, 1, { shoot: (p, n) => shot(p, `1440-${n === 'signin' ? '01-sign-in' : '02-sign-in-code'}.png`) });
  await page.waitForSelector('dialog .ed-rows-tools');
  await shot(page, '1440-03-proposals-empty.png');
  const id = await openDemo(page, a);
  await attachTestFiles(page);
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.check('#ck-email');
  await page.evaluate(() => { const d = document.querySelector('dialog'); d.scrollTop = d.scrollHeight; });
  await page.waitForTimeout(200);
  await shot(page, '1440-04-checklist-ready.png');
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Published")', { timeout: 30000 });
  await page.waitForTimeout(200);
  await shot(page, '1440-05-published.png');
  const [link, pass] = await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent));
  await page.click('dialog .ed-dialog-head button');
  await page.waitForTimeout(300);
  await shot(page, '1440-06-editor-issued.png');

  const client = async (width, height, scale, tag) => {
    const c = await browser.newContext({ ...AU, viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const p = await c.newPage();
    await p.goto(link);
    await p.waitForSelector('#gate-form');
    await p.waitForTimeout(300);
    await p.screenshot({ path: resolve(dir, `${tag}-07-gate.png`) });
    if (tag === '390') {
      await p.fill('#gate-pass', 'harbour-lantern-copper-marsh-quartz-000');
      await p.click('#gate-go');
      await p.waitForFunction(() => document.getElementById('gate-msg').textContent.length > 5);
      await p.screenshot({ path: resolve(dir, `${tag}-08-gate-wrong.png`) });
    }
    await p.fill('#gate-pass', pass);
    await p.click('#gate-go');
    await p.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 15000 });
    await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; return window.whenImagesReady(document.getElementById('cover'), 8000); });
    await p.waitForTimeout(400);
    await p.screenshot({ path: resolve(dir, `${tag}-09-unlocked.png`) });
    return { c, p };
  };
  const desk = await client(1440, 900, 1, '1440');
  await desk.c.close();
  const phone = await client(390, 844, 2, '390');

  // Rev B, then the client on the same link, and Rev A from the footer.
  await page.fill('[data-path="meta.project"] input', 'Proposed specialist controlled rock removal, Stage 2');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent));
  await page.click('#ed-check');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog .ed-ck')].some((s) => /Changes since/.test(s.textContent) && /Cover/.test(s.textContent)));
  await page.fill('#ck-note', 'Stage 2 named in the title');
  await page.evaluate(() => { const d = document.querySelector('dialog'); d.scrollTop = d.scrollHeight; });
  await page.waitForTimeout(200);
  await shot(page, '1440-10-checklist-rev-b.png');
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Rev B")', { timeout: 30000 });
  await page.waitForTimeout(200);
  await shot(page, '1440-11-published-rev-b.png');
  await page.click('dialog .ed-dialog-head button');

  await phone.p.goto(link);
  await phone.p.fill('#gate-pass', pass);
  await phone.p.click('#gate-go');
  await phone.p.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 15000 });
  await phone.p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.body.scrollHeight); });
  await phone.p.waitForTimeout(500);
  await phone.p.screenshot({ path: resolve(dir, '390-12-footer-revisions.png') });
  await phone.p.click('[data-revision-links] a:has-text("Rev A")');
  await phone.p.waitForFunction(() => !document.getElementById('superseded').hidden, null, { timeout: 15000 });
  await phone.p.evaluate(() => window.whenImagesReady(document.getElementById('cover'), 8000));
  await phone.p.waitForTimeout(500);
  await phone.p.screenshot({ path: resolve(dir, '390-13-rev-a-superseded.png') });
  const dead = await phone.c.newPage();
  await dead.goto(link.replace(/t=[a-f0-9]+/, `t=${'0'.repeat(64)}`));
  await dead.waitForSelector('[data-gate="gone"]:not([hidden])');
  await dead.screenshot({ path: resolve(dir, '390-14-link-not-active.png') });
  await phone.c.close();

  // A new person asks for access; an administrator sees it in People.
  await fetch(`${a.url}/api/auth?action=code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam.estimator@example.com' }) });
  await page.click('#ed-menu');
  await page.waitForTimeout(150);
  await shot(page, '1440-15-menu.png');
  await page.click('dialog .ed-menu-item:has-text("People")');
  await page.waitForSelector('dialog .ed-person.is-pending');
  await page.waitForTimeout(200);
  await shot(page, '1440-16-people-request.png');
  await ctx.close();
  return readdirSync(dir).length;
}

/** Each document the client can open gets a plain test file, through the editor (Phase 3 captures need a publishable proposal). */
async function attachTestFiles(page) {
  const { attachInEditor, testPdf } = await import('../lib/server-suites.mjs');
  const cards = await page.evaluate(() => window.__editor.state.cfg.attachments || []);
  await page.evaluate(() => { window.__editor.state.open.add('attachments'); window.__editor.ctx.refresh(); });
  for (const [i, card] of cards.entries()) if (card.visibility === 'client') await attachInEditor(page, i, `${card.id}.pdf`, testPdf(card.title));
}

/**
 * Phase 4, staff side first: documents attached and checked — one of the
 * suite's own forms refused for its scripts and replaced by a flattened copy,
 * a client's scan that could not be verified released with a reason — then
 * the checklist, a preview, and the client's documents and viewer.
 */
async function phase4Stills() {
  const dir = resolve(OUT, 'phase4');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: resolve(dir, name) });
  const { attachInEditor } = await import('../lib/server-suites.mjs');
  const { FIXTURES } = await import('../lib/pdf-fixtures.mjs');

  // Two of the suite's own forms (names and codes from the register), as issued and flattened.
  const register = JSON.parse(readFileSync(resolve(ROOT, 'content/register.json'), 'utf8')).documents;
  const [form, report] = [register[0], register.find((d) => d.id.endsWith('10'))];
  const suiteDir = resolve(ROOT, '../texc/documents/exemplars/pdf');
  const fileOf = (doc) => (existsSync(suiteDir) ? readdirSync(suiteDir).find((n) => n.startsWith(`${doc.id}_`)) : null);
  if (!fileOf(form) || !fileOf(report)) throw new Error('the Phase 4 captures need the sibling ../texc checkout (the suite PDFs)');
  const flatDir = resolve(OUT, 'attachments-check');
  mkdirSync(flatDir, { recursive: true });
  const flatPath = resolve(flatDir, `${form.id}-capture-flattened.pdf`);
  if (spawnSync('pdftocairo', ['-pdf', resolve(suiteDir, fileOf(form)), flatPath]).status !== 0) throw new Error('pdftocairo is needed to flatten the suite form');
  const cards = [
    { id: 'a1', title: form.title, category: 'risk', docCode: form.code, visibility: 'client' },
    { id: 'a2', title: report.title, category: 'risk', docCode: report.code, visibility: 'client' },
    { id: 'a3', title: 'Stage 2 corridor survey, scanned (client supplied)', category: 'drawings', docRev: 'C', docDate: '2026-09-22', visibility: 'client' },
    { id: 'a4', title: 'Certificate of currency', category: 'certificates', visibility: 'on-request' },
  ];

  let { ctx, page, a } = await signedIn(1440, 900, 1);
  const id = await openDemo(page, a);
  await page.evaluate((list) => window.__editor.ctx.set('attachments', list, { structural: true }), cards);
  await page.evaluate(() => { window.__editor.state.open.add('attachments'); window.__editor.ctx.refresh(); });
  await attachInEditor(page, 0, fileOf(form), readFileSync(resolve(suiteDir, fileOf(form))));
  await attachInEditor(page, 1, fileOf(report), readFileSync(resolve(suiteDir, fileOf(report))));
  await attachInEditor(page, 2, 'stage-2-survey-scan.pdf', FIXTURES['a stream in a filter the check cannot read (LZW)'].bytes());
  // Each card's verdict box whole, with the fields above it for context.
  await focusPanel(page, 'attachments', { inner: '[data-path="attachments.0.file"]', drawerOffset: 330 });
  await shot(page, '1440-01-documents-refused.png');
  await focusPanel(page, 'attachments', { inner: '[data-path="attachments.2.file"]', drawerOffset: 330 });
  await shot(page, '1440-02-documents-cannot-verify.png');
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  await page.waitForTimeout(200);
  await shot(page, '1440-03-checklist-blocked.png');
  await page.click('dialog .ed-dialog-head button');

  await attachInEditor(page, 0, fileOf(form).replace(/\.pdf$/, '_flattened.pdf'), readFileSync(flatPath));
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Scanned survey from the client, opened and read through by hand before sending.' : undefined));
  await page.click('[data-path="attachments.2.file"] button:has-text("Release")');
  await page.waitForFunction(() => document.querySelector('[data-path="attachments.2.file"]')?.dataset.state === 'override');
  await focusPanel(page, 'attachments', { inner: '[data-path="attachments"] .ed-row' });
  await shot(page, '1440-04-documents-ready.png');
  await focusPanel(page, 'attachments', { inner: '[data-path="attachments"] .ed-row:has([data-path="attachments.2.file"])' });
  await shot(page, '1440-05-documents-released.png');
  await page.click('[data-path="attachments.0.file"] button:has-text("Preview")');
  await page.waitForSelector('dialog.viewer figure[data-drawn]', { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot(page, '1440-06-preview.png');
  await page.keyboard.press('Escape');

  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Published")', { timeout: 30000 });
  const [link, pass] = await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent));
  await page.click('dialog .ed-dialog-head button');
  await ctx.close();

  // The editor on a phone: the Documents panel.
  ({ ctx, page, a } = await signedIn(390, 844, 2));
  await page.goto(`${a.url}/editor/${id}`);
  await page.waitForFunction(() => window.__editor && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  await focusPanel(page, 'attachments', { inner: '[data-path="attachments.0.file"]', drawerOffset: 420 });
  await shot(page, '390-10-editor-documents.png');
  await ctx.close();

  for (const [width, height, scale, tag] of [[1440, 900, 1, '1440'], [390, 844, 2, '390']]) {
    const c = await browser.newContext({ ...AU, viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const p = await c.newPage();
    await p.goto(link);
    await p.fill('#gate-pass', pass);
    await p.click('#gate-go');
    await p.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 15000 });
    await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; const s = document.getElementById('attachments'); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 64); });
    await p.waitForTimeout(700);
    await p.screenshot({ path: resolve(dir, `${tag}-07-client-documents.png`) });
    await p.click('#attachments [data-attachment="a1"][data-action="view"]');
    await p.waitForSelector('dialog.viewer figure[data-drawn]', { timeout: 30000 });
    await p.waitForTimeout(500);
    await p.screenshot({ path: resolve(dir, `${tag}-08-client-viewer.png`) });
    if (tag === '390') {
      await p.evaluate(() => { const b = document.querySelector('dialog.viewer .viewer-body'); b.scrollTop = b.scrollHeight / 2; });
      await p.waitForTimeout(800);
      await p.screenshot({ path: resolve(dir, `${tag}-09-client-viewer-scrolled.png`) });
    }
    await c.close();
  }
  return readdirSync(dir).length;
}

/**
 * Phase 5, as people meet it: the client reads the acceptance on a desktop,
 * asks for a change, then signs and accepts on a phone; the office gets the
 * email and opens the record; the person accepting gets theirs; a revision
 * after acceptance asks to be accepted again; an administrator records an
 * acceptance that came by email.
 */
async function phase5Stills() {
  const dir = resolve(OUT, 'phase5');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shot = (page, name, opts = {}) => page.screenshot({ path: resolve(dir, name), ...opts });
  const toAccept = (p) => p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; const s = document.getElementById('accept'); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 64); });
  const toEl = (p, sel, gap = 140) => p.evaluate(([q, g]) => { const n = document.querySelector(q); window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - g); }, [sel, gap]);

  let { ctx, page, a } = await signedIn(1440, 900, 1);
  const id = await openDemo(page, a);
  await attachTestFiles(page);
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Published")', { timeout: 30000 });
  const [link, pass] = await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent));
  await page.click('dialog .ed-dialog-head button');

  const unlock = async (width, height, scale) => {
    const c = await browser.newContext({ ...AU, viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const p = await c.newPage();
    await p.goto(link);
    await p.fill('#gate-pass', pass);
    await p.click('#gate-go');
    await p.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 15000 });
    await toAccept(p);
    await p.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /\/assets\/js\/signature\.js$/.test(e.name)), null, { timeout: 10000 });
    await p.waitForTimeout(500);
    return { c, p };
  };

  // The client, at a desk: the acceptance as it arrives, then incomplete, then a request for changes.
  const desk = await unlock(1440, 900, 1);
  await shot(desk.p, '1440-01-acceptance.png');
  await desk.p.click('[data-accept-go]');
  await desk.p.waitForTimeout(200);
  await toEl(desk.p, '[data-accept-form] [name="email"]', 260);
  await shot(desk.p, '1440-02-acceptance-incomplete.png');
  await toEl(desk.p, '[data-accept-go]', 620);
  await shot(desk.p, '1440-02b-acceptance-incomplete-message.png');
  await desk.p.click('[data-request-changes]');
  await desk.p.fill('[data-changes-form] [name="email"]', 'sam.whitlock@example.com');
  await desk.p.fill('[data-changes-form] [name="message"]', 'Could the start move to the week of 2 November? Our earthworks contractor is not off site until 30 October.');
  await desk.p.evaluate(() => document.querySelector('[data-changes-form]').scrollIntoView({ block: 'center' }));
  await desk.p.waitForTimeout(200);
  await shot(desk.p, '1440-03-request-changes.png');
  await desk.p.click('[data-changes-go]');
  await desk.p.waitForFunction(() => /Sent/.test(document.querySelector('[data-changes-note]').textContent));
  await shot(desk.p, '1440-04-request-sent.png');

  // The client, on a phone: the optional item, details, a drawn signature, accepted.
  const phone = await unlock(390, 844, 2);
  await phone.p.evaluate(() => document.querySelector('#quote [data-option="o1"]').scrollIntoView({ block: 'center' }));
  await phone.p.check('#quote [data-option="o1"]');
  await toAccept(phone.p);
  await phone.p.fill('[data-accept-form] [name="email"]', 'sam.whitlock@example.com');
  await phone.p.check('[data-accept-form] [name="authority"]');
  await phone.p.check('[data-accept-form] [name="accept"]');
  const pad = await phone.p.$eval('[data-sig-canvas]', (c) => { c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  // A plausible hand: a loop, a rise and a long tail.
  const path = [];
  for (let i = 0; i <= 60; i += 1) { const t = i / 60; path.push([0.1 + 0.75 * t + 0.05 * Math.sin(t * 18), 0.58 - 0.22 * Math.sin(t * Math.PI * 3) * (1 - t * 0.6)]); }
  await phone.p.mouse.move(pad.x + pad.w * path[0][0], pad.y + pad.h * path[0][1]);
  await phone.p.mouse.down();
  for (const [x, y] of path.slice(1)) await phone.p.mouse.move(pad.x + pad.w * x, pad.y + pad.h * y);
  await phone.p.mouse.up();
  await phone.p.waitForTimeout(150);
  await shot(phone.p, '390-05-signed.png');
  await phone.p.click('[data-accept-go]');
  await phone.p.waitForSelector('[data-accept-done]:not([hidden])', { timeout: 20000 });
  await toEl(phone.p, '[data-accept-done]');
  await phone.p.waitForTimeout(300);
  await shot(phone.p, '390-06-accepted.png');
  await toEl(phone.p, '#quote [data-quote-lines] tr.is-optional', 360);
  await phone.p.waitForTimeout(300);
  await shot(phone.p, '390-07-quotation-locked.png');
  await desk.p.reload();
  await desk.p.fill('#gate-pass', pass);
  await desk.p.click('#gate-go');
  await desk.p.waitForSelector('[data-accept-done]:not([hidden])', { timeout: 15000 });
  await toAccept(desk.p);
  await desk.p.waitForTimeout(400);
  await shot(desk.p, '1440-08-accepted.png');
  await desk.c.close();

  // The office: the editor says so, the record, and the emails sent.
  await page.reload();
  await page.waitForFunction(() => window.__editor && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  await shot(page, '1440-09-editor-accepted.png');
  const accId = await page.evaluate(() => window.__editor.state.proposal.acceptances[0].id);
  const rec = await ctx.newPage();
  await rec.goto(`${a.url}/staff/acceptance/${accId}`);
  await rec.waitForTimeout(300);
  await shot(rec, '1440-10-acceptance-record.png', { fullPage: true });
  await rec.pdf({ path: resolve(dir, 'acceptance-record-A4.pdf'), format: 'A4', printBackground: true });
  await rec.close();
  const mails = a.outbox();
  const mailShot = async (match, name) => {
    const m = mails.filter((x) => match(x)).at(-1);
    if (!m) return;
    const mp = await ctx.newPage();
    await mp.setViewportSize({ width: 720, height: 900 });
    await mp.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f2f2f2"><p style="font:12px Helvetica,Arial;color:#555;padding:12px 24px;margin:0">To: ${m.to.join(', ')}<br>Subject: ${m.subject}</p>${m.html}</body>`);
    await shot(mp, name, { fullPage: true });
    await mp.close();
  };
  await mailShot((m) => /^Changes requested:/.test(m.subject), 'email-01-changes-requested.png');
  await mailShot((m) => /^Accepted:/.test(m.subject), 'email-02-office-accepted.png');
  await mailShot((m) => /^Your acceptance:/.test(m.subject), 'email-03-person-accepted.png');

  // A revision after acceptance: the checklist says so, then the client is asked again.
  await page.fill('[data-path="meta.project"] input', 'Proposed specialist controlled rock removal, Stage 2');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent));
  await page.click('#ed-check');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog .ed-ack')].some((n) => /was accepted by/.test(n.textContent)));
  await page.evaluate(() => [...document.querySelectorAll('dialog .ed-ack')].find((n) => /was accepted by/.test(n.textContent)).scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await shot(page, '1440-11-checklist-reacceptance.png');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.fill('#ck-note', 'Start moved to the week of 2 November, as asked');
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Rev B")', { timeout: 30000 });
  await page.click('dialog .ed-dialog-head button');
  await phone.p.goto(link);
  await phone.p.fill('#gate-pass', pass);
  await phone.p.click('#gate-go');
  await phone.p.waitForSelector('[data-accept-banner]:not([hidden])', { timeout: 15000 });
  await toAccept(phone.p);
  await phone.p.waitForTimeout(400);
  await shot(phone.p, '390-12-revision-b-reaccept.png');
  await toEl(phone.p, '[data-accept-form]', 160);
  await phone.p.waitForTimeout(300);
  await shot(phone.p, '390-12b-revision-b-form.png');
  await phone.p.click('[data-revision-links] a:has-text("Rev A")');
  await phone.p.waitForSelector('[data-accept-done]:not([hidden])', { timeout: 15000 });
  await toEl(phone.p, '[data-accept-done]');
  await phone.p.waitForTimeout(400);
  await shot(phone.p, '390-13-revision-a-accepted.png');
  await phone.c.close();

  // An acceptance that came by email: an administrator records it.
  await page.click('#ed-menu');
  await page.click('dialog .ed-menu-item:has-text("Record an acceptance")');
  await page.fill('#ra-note', 'Signed PDF of Rev B returned by email on 15 October, from sam.whitlock@example.com.');
  await page.waitForTimeout(200);
  await shot(page, '1440-14-record-acceptance.png');
  await page.click('#ra-go');
  await page.waitForFunction(() => (window.__editor.state.proposal.acceptances || []).length === 2, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '1440-15-editor-recorded.png');
  await ctx.close();
  void id;
  return readdirSync(dir).length;
}

/**
 * Phase 6, staff side, on a year of FICTIONAL proposals (dashboard-seed.mjs):
 * the dashboard as it opens, the chart and its table, who needs a call, the
 * list filtered and searched, one proposal's history, archiving — and what
 * the editor and the client's link then do — and restoring; a viewer's
 * read-only view; the editor's new ways in. Then the same on a phone.
 */
async function phase6Stills() {
  const dir = resolve(OUT, 'phase6');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shot = (page, name, opts = {}) => page.screenshot({ path: resolve(dir, name), ...opts });
  const a = await localApp();
  const { seedDashboard } = await import('./dashboard-seed.mjs');
  const { psql } = await import('../lib/local-supabase.mjs');
  const { ids } = seedDashboard(a.sb.conn);
  const settle = (p, ms = 300) => p.waitForTimeout(ms);
  const toEl = (p, sel, gap = 72) => p.evaluate(([q, g]) => { const n = document.querySelector(q); window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - g); }, [sel, gap]);
  // The whole element, wherever it is on the page (an element screenshot can stop at the window's edge).
  const shotEl = async (p, sel, name, pad = 16) => {
    const r = await p.evaluate((q) => { const b = document.querySelector(q).getBoundingClientRect(); return { x: b.left, y: b.top + window.scrollY, w: b.width, h: b.height }; }, sel);
    await shot(p, name, { fullPage: true, clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + 2 * pad, height: r.h + 2 * pad } });
  };
  const dash = async (p, query = '') => { await p.goto(`${a.url}/dashboard${query}`); await p.waitForSelector('.db-svg'); await settle(p); };

  // Before: where signing in led, and the editor's menu, until now (the Phase 3 captures, when they are here).
  for (const [from, to] of [['phase3/1440-03-proposals-empty.png', 'before-1440-signed-in-landing.png'], ['phase3/1440-15-menu.png', 'before-1440-editor-menu.png']]) {
    if (existsSync(resolve(OUT, from))) copyFileSync(resolve(OUT, from), resolve(dir, to));
  }

  let { ctx, page } = await signedIn(1440, 900, 1);
  await dash(page);
  await shot(page, '1440-01-dashboard.png');
  // Scroll first and shoot a clip: an element screenshot would scroll after the hover and lose it.
  await toEl(page, '.db-split', 80);
  await page.locator('.db-col').nth(10).hover();
  await settle(page, 150);
  const split = await page.locator('.db-split').boundingBox();
  await shot(page, '1440-02-chart-month-and-follow-ups.png', { clip: { x: split.x - 16, y: split.y - 16, width: split.width + 32, height: Math.min(split.height + 32, 900 - split.y) } });
  await page.mouse.move(5, 5);
  await page.click('#db-chart-table-btn');
  await settle(page, 150);
  await shotEl(page, '.db-chart', '1440-03-chart-as-a-table.png');
  await page.click('#db-chart-table-btn');
  await shot(page, '1440-04-full-page.png', { fullPage: true });
  await page.selectOption('#f-state', 'followup');
  await toEl(page, '.db-list');
  await settle(page);
  await shot(page, '1440-05-needs-a-follow-up.png');
  await page.selectOption('#f-state', '');
  await page.fill('#f-q', 'ashgrove');
  await page.waitForFunction(() => /q=ashgrove/.test(location.search));
  await settle(page, 400);
  await shotEl(page, '.db-list', '1440-06-search.png');

  // One proposal's whole story: changes asked for, Rev B, accepted.
  await dash(page, `?open=${ids.latrobe}`);
  await page.waitForSelector('.db-timeline');
  await settle(page);
  await shot(page, '1440-07-history.png');
  await page.evaluate(() => { const p = document.getElementById('db-panel'); p.scrollTop = p.scrollHeight; });
  await settle(page, 150);
  await shot(page, '1440-08-history-continued.png');

  // Archive a live one, see what that does, and restore it.
  await dash(page, `?open=${ids.bicheno}`);
  await page.waitForSelector('#db-archive');
  await page.click('#db-archive');
  await page.selectOption('#db-ar-reason', 'Awarded to another contractor');
  await settle(page, 150);
  await shot(page, '1440-09-archive.png');
  await page.click('.db-archive-form [type=submit]');
  await page.waitForSelector('#db-restore');
  await settle(page);
  await shot(page, '1440-10-archived.png');
  await page.click('#db-panel .db-close');
  await page.selectOption('#f-state', 'archived');
  await toEl(page, '.db-list');
  await settle(page);
  await shot(page, '1440-11-archived-list.png');
  await page.goto(`${a.url}/editor/${ids.bicheno}`);
  await page.waitForSelector('dialog .ed-dialog-foot');
  await settle(page, 500);
  await shot(page, '1440-12-editor-on-an-archived-proposal.png');
  const [slug, token] = psql(a.sb.conn, `select slug || ' ' || access_token from public.texc_proposals where id = '${ids.bicheno}'`).split(' ');
  const clientCtx = await browser.newContext({ ...AU, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const cp = await clientCtx.newPage();
  await cp.goto(`${a.url}/p/${slug}?t=${token}`);
  await cp.waitForSelector('[data-gate="gone"]:not([hidden])');
  await settle(cp, 500);
  await cp.screenshot({ path: resolve(dir, '1440-13-client-link-while-archived.png') });
  await clientCtx.close();
  await dash(page, `?open=${ids.bicheno}`);
  await page.click('#db-restore');
  await page.waitForSelector('#db-archive');
  await settle(page);
  await shot(page, '1440-14-restored.png');

  // The editor's ways in: the list and the menu.
  await page.goto(`${a.url}/editor`);
  await page.waitForSelector('dialog .ed-proposals, dialog .ed-list .ed-hint');
  await settle(page, 400);
  await shot(page, '1440-15-editor-list.png');
  await page.goto(`${a.url}/editor/${ids.poatina}`);
  await page.waitForSelector('#ed-menu');
  await page.click('#ed-menu');
  await settle(page, 300);
  await shot(page, '1440-16-editor-menu.png');

  // The export, as a file to open.
  const csv = await page.evaluate(async () => (await fetch('/api/export?state=followup')).text());
  writeFileSync(resolve(dir, 'export-needs-a-follow-up.csv'), `﻿${csv}`);

  // A viewer: everything to read, nothing to change.
  const viewerEmail = 'pat.viewer@example.com';
  await page.evaluate(async (email) => {
    await fetch('/api/auth?action=code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    await fetch('/api/people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, status: 'active', role: 'viewer' }) });
  }, viewerEmail);
  const vctx = await browser.newContext({ ...AU, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const vp = await vctx.newPage();
  await vp.goto(`${a.url}/signin`);
  await vp.fill('#email', viewerEmail);
  await vp.click('#email-form button');
  await vp.waitForSelector('[data-step="code"]:not([hidden])');
  await vp.fill('#code', a.codeFor(a.outbox(), viewerEmail));
  await vp.click('#code-form button');
  await vp.waitForURL((u) => u.pathname === '/dashboard');
  await vp.waitForSelector('.db-svg');
  await settle(vp);
  await vp.screenshot({ path: resolve(dir, '1440-17-viewer-signed-in.png') });
  await vp.goto(`${a.url}/dashboard?open=${ids.stanley}`);
  await vp.waitForSelector('.db-timeline');
  await settle(vp);
  await vp.screenshot({ path: resolve(dir, '1440-18-viewer-history.png') });
  await vctx.close();
  const state = await ctx.storageState();
  await ctx.close();

  // A scroll through the whole page.
  const vdir = resolve(OUT, 'video-tmp');
  rmSync(vdir, { recursive: true, force: true });
  const rctx = await browser.newContext({ ...AU, viewport: { width: 1440, height: 900 }, storageState: state, recordVideo: { dir: vdir, size: { width: 1440, height: 900 } } });
  const rp = await rctx.newPage();
  await dash(rp);
  await rp.waitForTimeout(1200);
  const total = await rp.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  for (let y = 0; y < total; y += 36) { await rp.evaluate((top) => window.scrollTo(0, top), y); await rp.waitForTimeout(64); }
  await rp.waitForTimeout(1200);
  await rctx.close();
  const webm = readdirSync(vdir).find((f) => f.endsWith('.webm'));
  renameSync(resolve(vdir, webm), resolve(dir, 'dashboard-scroll-1440.webm'));
  rmSync(vdir, { recursive: true, force: true });
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', resolve(dir, 'dashboard-scroll-1440.webm'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(dir, 'dashboard-scroll-1440.mp4')]);

  // On a phone.
  const pctx = await browser.newContext({ ...AU, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce', storageState: state });
  const pp = await pctx.newPage();
  await dash(pp);
  await shot(pp, '390-01-dashboard.png');
  await toEl(pp, '.db-chart');
  await pp.locator('.db-col').nth(10).focus();
  await settle(pp, 150);
  await shot(pp, '390-02-chart.png');
  await pp.locator('.db-col').nth(10).blur();
  await toEl(pp, '.db-follow');
  await settle(pp, 150);
  await shot(pp, '390-03-follow-ups.png');
  await toEl(pp, '.db-list');
  await settle(pp, 150);
  await shot(pp, '390-04-list.png');
  await toEl(pp, '#db-rows tr:nth-child(2)', 64);
  await settle(pp, 150);
  await shot(pp, '390-05-list-cards.png');
  await dash(pp, `?open=${ids.latrobe}`);
  await pp.waitForSelector('.db-timeline');
  await settle(pp);
  await shot(pp, '390-06-history.png');
  await pp.evaluate(() => { const p = document.getElementById('db-panel'); p.scrollTop = p.scrollHeight; });
  await settle(pp, 150);
  await shot(pp, '390-07-history-continued.png');
  await dash(pp, `?open=${ids.wilmot}`);
  await pp.click('#db-archive');
  await pp.selectOption('#db-ar-reason', 'The client did not go ahead');
  await settle(pp, 150);
  await shot(pp, '390-08-archive.png');
  await pctx.close();
  return readdirSync(dir).length;
}

async function pdf() {
  const page = await browser.newPage({ ...AU, viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  await ready(page);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.pdf({ path: resolve(OUT, 'demo-proposal-A4.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  await page.close();
}

mkdirSync(OUT, { recursive: true });
try {
  if (process.argv.includes('--editor')) {
    console.log(`demo-out/editor/: ${await editorStills()} editor captures`);
  } else if (process.argv.includes('--phase3')) {
    console.log(`demo-out/phase3/: ${await phase3Stills()} captures`);
  } else if (process.argv.includes('--phase4')) {
    console.log(`demo-out/phase4/: ${await phase4Stills()} captures`);
  } else if (process.argv.includes('--phase5')) {
    console.log(`demo-out/phase5/: ${await phase5Stills()} captures`);
  } else if (process.argv.includes('--phase6')) {
    console.log(`demo-out/phase6/: ${await phase6Stills()} files`);
  } else {
    const desk = await stills(1440, 900, 1);
    const phone = await stills(390, 844, 2);
    await video(1440, 900, 1);
    await video(390, 844, 1);
    await pdf();
    const e = await editorStills();
    const p3 = await phase3Stills();
    const p4 = await phase4Stills();
    const p5 = await phase5Stills();
    const p6 = await phase6Stills();
    console.log(`demo-out/: ${desk} sections at 1440, ${phone} at 390, arrival shots, two scroll videos, A4 PDF, ${e} editor, ${p3} Phase 3, ${p4} Phase 4, ${p5} Phase 5 captures and ${p6} Phase 6 files`);
  }
} finally {
  await browser.close();
  server.close();
  if (APP) APP.stop();
}

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
 *
 *   node scripts/demo/capture.mjs              everything
 *   node scripts/demo/capture.mjs --editor     the editor captures only
 *   node scripts/demo/capture.mjs --phase3     the Phase 3 captures only
 *
 * Section stills hide the fixed furniture (top bar, rail, back-to-top) so a
 * sticky bar is never stitched into the middle of a section; the arrival shots
 * keep it. Look at every capture before sending it.
 * Exit 2 when no browser could be started.
 */
import { mkdirSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
const browser = await pw.chromium.launch();

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
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
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
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, recordVideo: { dir: vdir, size: { width, height } } });
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
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', ...(staffState && !shoot ? { storageState: staffState } : {}) });
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
async function focusPanel(page, sec, { inner, preview = sec, previewOffset = 0 } = {}) {
  await page.evaluate(({ sec, inner, preview, previewOffset }) => {
    const ed = window.__editor;
    ed.state.open = new Set([sec]);
    ed.ctx.refresh();
    const host = document.getElementById('ed-panels');
    const target = document.querySelector(`.ed-panel[data-sec="${sec}"] ${inner || ''}`.trim());
    host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - 8;
    const s = document.getElementById(preview);
    if (s) window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 76 + previewOffset);
  }, { sec, inner: inner || '', preview, previewOffset });
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
    const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
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

async function pdf() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
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
  } else {
    const desk = await stills(1440, 900, 1);
    const phone = await stills(390, 844, 2);
    await video(1440, 900, 1);
    await video(390, 844, 1);
    await pdf();
    const e = await editorStills();
    const p3 = await phase3Stills();
    console.log(`demo-out/: ${desk} sections at 1440, ${phone} at 390, arrival shots, two scroll videos, A4 PDF, ${e} editor and ${p3} Phase 3 captures`);
  }
} finally {
  await browser.close();
  server.close();
  if (APP) APP.stop();
}

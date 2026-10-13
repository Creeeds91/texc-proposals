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
 *   demo-out/editor/*.png            the editor, staff side: desktop and phone
 *
 *   node scripts/demo/capture.mjs              everything
 *   node scripts/demo/capture.mjs --editor     the editor captures only
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

const EDITOR = `http://127.0.0.1:${PORT}/editor`;

async function editorPage(width, height, scale) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(EDITOR, { waitUntil: 'networkidle' });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  return { ctx, page };
}

const loadDemo = (page) => page.evaluate(async () => {
  const res = await fetch('/fixtures/demo-proposal.json');
  window.__editor.load(await res.json(), 'Demo loaded');
});

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

  // Desktop, 1440.
  let { ctx, page } = await editorPage(1440, 900, 1);
  await page.waitForTimeout(300);
  await shot(page, '1440-01-new-proposal.png');
  await loadDemo(page);
  await page.evaluate(() => window.whenImagesReady(document, 8000));
  await page.waitForTimeout(300);
  await shot(page, '1440-02-demo-cover.png');
  await focusPanel(page, 'scope', { inner: '.ed-row' });
  await shot(page, '1440-03-scope-locked-safety-line.png');
  await focusPanel(page, 'risk', { inner: '[data-path="risk.hazards"]', previewOffset: 520 });
  await shot(page, '1440-04-hazards.png');
  await focusPanel(page, 'risk', { inner: '[data-path="risk.hazards"] > .ed-rows-tools' , previewOffset: 520 });
  await shot(page, '1440-05-hazard-presets.png');
  await focusPanel(page, 'quote', { inner: '[data-path="quote.lines"]', previewOffset: 180 });
  await shot(page, '1440-06-quotation.png');
  await focusPanel(page, 'understanding', { inner: '[data-path="understanding.callout.lead"]', previewOffset: 0 });
  await page.click('.ed-panel[data-sec="understanding"] [data-path="understanding.callout.lead"] .ed-flag');
  await page.waitForTimeout(150);
  await focusPanel(page, 'understanding', { inner: '[data-path="understanding.callout.lead"]', preview: 'understanding', previewOffset: 0 });
  await page.evaluate(() => document.querySelector('#understanding mark.confirm')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await shot(page, '1440-07-confirm-flag.png');
  await page.click('.ed-panel[data-sec="understanding"] [data-path="understanding.callout.lead"] .ed-flag');
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
  await page.click('#ed-collapse');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await shot(page, '1440-10-editor-hidden.png');
  await ctx.close();

  // Phone, 390 at 2x.
  ({ ctx, page } = await editorPage(390, 844, 2));
  await loadDemo(page);
  await page.waitForTimeout(300);
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

async function pdf() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  await ready(page);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.pdf({ path: resolve(OUT, 'demo-proposal-A4.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  await page.close();
}

mkdirSync(OUT, { recursive: true });
if (process.argv.includes('--editor')) {
  const n = await editorStills();
  console.log(`demo-out/editor/: ${n} editor captures`);
} else {
  const desk = await stills(1440, 900, 1);
  const phone = await stills(390, 844, 2);
  await video(1440, 900, 1);
  await video(390, 844, 1);
  await pdf();
  const n = await editorStills();
  console.log(`demo-out/: ${desk} sections at 1440, ${phone} at 390, arrival shots, two scroll videos, A4 PDF, ${n} editor captures`);
}
await browser.close();
server.close();

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
 *
 *   node scripts/demo/capture.mjs
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

async function pdf() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  await ready(page);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.pdf({ path: resolve(OUT, 'demo-proposal-A4.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  await page.close();
}

mkdirSync(OUT, { recursive: true });
const desk = await stills(1440, 900, 1);
const phone = await stills(390, 844, 2);
await video(1440, 900, 1);
await video(390, 844, 1);
await pdf();
await browser.close();
server.close();
console.log(`demo-out/: ${desk} sections at 1440, ${phone} at 390, arrival shots, two scroll videos, A4 PDF`);

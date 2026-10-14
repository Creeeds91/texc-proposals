#!/usr/bin/env node
/**
 * The staff guide (docs/editor-guide.md, with its pictures in docs/guide/) as
 * a printable A4 PDF for TEXC: demo-out/editor-guide.pdf.
 *
 *   node scripts/demo/guide.mjs
 *
 * A small Markdown reader for exactly what the guide uses — headings,
 * paragraphs, lists, tables, pictures, bold and code — laid out in TEXC's
 * tokens and printed by Chromium. Exit 2 when no browser could be started.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaywright } from '../lib/browser.mjs';
import { BRAND } from '../../lib/brand.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*([^*]+)\*/g, '<em>$1</em>');

export function markdownToHtml(md, base) {
  const out = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para = [];
  let list = null;
  let table = null;
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (list) { out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; }
    if (table) {
      const [head, , ...body] = table;
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      table = null;
    }
  };
  for (const line of lines) {
    let m;
    if (!line.trim()) { flush(); continue; }
    if (/^---+$/.test(line.trim())) { flush(); out.push('<hr>'); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim()))) { flush(); out.push(`<figure><img src="${pathToFileURL(resolve(base, m[2])).href}" alt="${esc(m[1])}"><figcaption>${esc(m[1])}</figcaption></figure>`); continue; }
    if (line.trim().startsWith('|')) { if (para.length || list) flush(); (table ||= []).push(line.trim()); continue; }
    if ((m = /^-\s+(.*)$/.exec(line))) { if (para.length || table) flush(); (list ||= []).push(m[1]); continue; }
    if (/^\s{2,}\S/.test(line) && list) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (table) flush();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pw = await loadPlaywright();
  if (!pw) { console.error('NOT RUN — Playwright not found'); process.exit(2); }
  const md = readFileSync(resolve(ROOT, 'docs/editor-guide.md'), 'utf8');
  const tokens = readFileSync(resolve(ROOT, 'assets/css/tokens.css'), 'utf8').replace(/url\("\/assets\//g, `url("${pathToFileURL(resolve(ROOT, 'assets')).href}/`);
  const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><title>${esc(BRAND.name)} Proposals: a guide for staff</title>
<style>${tokens}
@page { size: A4; margin: 16mm 15mm 18mm; }
body { font: 10.5pt/1.5 var(--font-body); color: var(--ink); margin: 0; }
h1 { font-family: var(--font-heading); font-weight: 800; text-transform: uppercase; font-size: 22pt; line-height: 1.05; margin: 0 0 6pt; border-bottom: 3pt solid var(--gold); padding-bottom: 8pt; }
h2 { font-family: var(--font-heading); font-weight: 800; text-transform: uppercase; font-size: 13pt; margin: 18pt 0 6pt; break-after: avoid; }
h3 { font-size: 11pt; margin: 12pt 0 4pt; break-after: avoid; }
p, li { margin: 0 0 6pt; } ul { padding-left: 16pt; margin: 0 0 8pt; }
hr { border: 0; border-top: 1px solid var(--doc-rule); margin: 12pt 0; }
code { font-family: Menlo, Consolas, monospace; font-size: 9pt; background: var(--doc-band); padding: 0 3pt; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9.5pt; break-inside: avoid; }
th, td { text-align: left; border-bottom: 1px solid var(--doc-rule); padding: 4pt 6pt; vertical-align: top; }
th { font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-on-paper-muted); }
figure { margin: 8pt 0 12pt; break-inside: avoid; }
figure img { display: block; max-width: 100%; max-height: 95mm; margin: 0 auto; border: 1px solid var(--doc-rule); }
figure img[src*="phone"] { max-height: 120mm; }
figcaption { font-size: 8.5pt; color: var(--ink-on-paper-muted); text-align: center; margin-top: 3pt; }
</style></head><body>${markdownToHtml(md, resolve(ROOT, 'docs'))}</body></html>`;
  const muted = (/--ink-on-paper-muted:\s*([^;]+);/.exec(tokens) || [])[1] || 'grey'; // the footer is drawn outside the page's styles
  const out = resolve(ROOT, 'demo-out');
  mkdirSync(out, { recursive: true });
  const htmlPath = resolve(out, 'editor-guide.html');
  writeFileSync(htmlPath, html);
  const browser = await pw.chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.pdf({ path: resolve(out, 'editor-guide.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="font: 7pt Arial, sans-serif; color: ${muted}; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between;"><span>${esc(BRAND.name)} Proposals: a guide for staff</span><span><span class="pageNumber"></span> of <span class="totalPages"></span></span></div>` });
  await browser.close();
  console.log('wrote demo-out/editor-guide.pdf');
}

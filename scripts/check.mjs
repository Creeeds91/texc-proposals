#!/usr/bin/env node
/**
 * Every offline check, as named suites. One command before any push:
 *
 *   node scripts/check.mjs                 all suites
 *   node scripts/check.mjs quote csp       just those
 *   node scripts/check.mjs contract --prove   also show the contract check bites
 *
 * Suites
 *   contract      the template carries every hook the runtime and editor rely on
 *   brand         no business name, phone, email or ABN typed outside lib/brand.js
 *   csp           built views have no inline script/style/handlers; headers are strict
 *   conventions   server code: no console.*, no select=*, no echoed database errors
 *   quote         quote maths: integer cents, half-up once per line, GST once
 *   design        no raw colour in any stylesheet but tokens.css; no hex in scripts
 *   rules         the pre-publish checklist and the sensitive-text scan, case by case
 *   confirm       a $confirm can never reach a client page            (browser)
 *   render        the demo renders with zero console errors or CSP violations (browser)
 *   print         every visible section prints, with ink, in an A4 PDF  (browser)
 *   schema        supabase/schema.sql stands up twice, locks down, keeps its promises   (Postgres + Docker)
 *   envelope      server encryption opens with the browser's own code    (browser)
 *   refusals      every bad client request gets the identical 410; staff endpoints refuse strangers   (stack)
 *   editor        the editor against the real stack: edits, rows, CONFIRM, upload,
 *                 checklist, server autosave, a colleague's conflicting save, phone   (stack + browser)
 *   flow          staff to client: publish, unlock, revise, supersede, rotate, approve a person   (stack + browser)
 *   attachments   the PDF check: built fixtures for each way a file can be unsafe, TEXC's
 *                 own suite PDFs against a second parser's view of them, their flattened
 *                 copies, and a fuzz that it never throws     (poppler, pypdf, sibling ../texc)
 *   content-sync  website wording and tokens still match the website, and every
 *                 Chalmers-derived library line is still TEXC's exact wording (sibling ../texc)
 *
 * Exit codes, as in the Roberts repo: 0 all passed · 1 something is broken ·
 * 2 a suite could not start at all · 3 nothing failed but something was NOT
 * CHECKED (no browser, no sibling checkout). A skip is "not checked", never "fine".
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build, checkView, templateData } from './build.mjs';
import { BRAND } from '../lib/brand.js';
import { CLIENT_CSP, EDITOR_CSP, WORKER_CSP } from '../lib/csp.js';
import { quoteTotals, lineAmountCents, formatAUD, formatQty } from '../assets/js/money.js';
import { runChecks } from '../assets/js/checks.js';
import { scanText, localityWarning } from '../assets/js/sensitive.js';
import { inspectPdf } from '../lib/pdf-inspect.js';
import { FIXTURES as PDF_FIXTURES } from './lib/pdf-fixtures.mjs';
import { suiteSchema, suiteEnvelope, suiteRefusals, suiteEditor, suiteFlow, closeServerSuites } from './lib/server-suites.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const args = process.argv.slice(2);
const PROVE = args.includes('--prove');

const PASS = 'pass', FAIL = 'fail', SKIP = 'not checked';

function walk(dir, exts) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...walk(relative(ROOT, p), exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(relative(ROOT, p));
  }
  return out.sort();
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');

/* ------------------------------------------------------------- contract */

const SECTIONS = ['cover', 'letter', 'glance', 'about', 'understanding', 'scope', 'site', 'method', 'params', 'env', 'risk', 'docs', 'logistics', 'team', 'programme', 'quote', 'attachments', 'terms', 'accept', 'contact'];
const REQUIRED_IDS = ['main', 'topbar', 'pbar', 'index', 'sheet', 'flt', 'superseded', 'demo-chip', 'index-toggle', 'brand-data', 'template-data', 'gate', 'gate-form', 'gate-pass', 'gate-msg'];
const REQUIRED_FIELDS = ['documentTitle', 'meta.project', 'meta.docTypeLabel', 'meta.siteLine', 'meta.reference', 'meta.revLabel', 'meta.issueDateText', 'meta.validUntilText', 'meta.statusLabel', 'meta.footerLine', 'client.company', 'client.contactLine', 'letter.greetingName', 'quote.subtotalText', 'quote.gstText', 'quote.totalText', 'accept.clause'];
const REQUIRED_IMGS = ['cover.image', 'letter.portrait', 'understanding.sitePlan', 'contact.photo'];
const REQUIRED_ROWS = ['understanding.photos', 'scope.services', 'scope.matrix', 'site.meta', 'site.constraints', 'method.steps', 'risk.hazards', 'risk.holdPoints', 'docs.items', 'team.people'];
const REQUIRED_HOOKS = ['data-quote-lines', 'data-quote-terms', 'data-params', 'data-workflow', 'data-timeline', 'data-attachments', 'data-accept-form', 'data-print', 'data-index-list', 'data-sheet-list', 'data-status-chip', 'data-secnum'];

function contractProblems(html) {
  const problems = [];
  const has = (re) => re.test(html);
  for (const id of REQUIRED_IDS) if (!has(new RegExp(`\\sid="${id}"`))) problems.push(`missing #${id}`);
  for (const sec of SECTIONS) if (!has(new RegExp(`data-sec="${sec}"`))) problems.push(`missing section data-sec="${sec}"`);
  for (const f of REQUIRED_FIELDS) if (!html.includes(`data-field="${f}"`)) problems.push(`missing data-field="${f}"`);
  for (const f of REQUIRED_IMGS) if (!html.includes(`data-img="${f}"`)) problems.push(`missing data-img="${f}"`);
  for (const f of REQUIRED_ROWS) if (!html.includes(`data-rows="${f}"`)) problems.push(`missing data-rows="${f}"`);
  for (const h of REQUIRED_HOOKS) if (!html.includes(h)) problems.push(`missing ${h}`);
  if ((html.match(/<h1\b/g) || []).length !== 1) problems.push('the page must have exactly one <h1>');
  for (const sec of SECTIONS.filter((s) => s !== 'cover' && s !== 'contact')) {
    const at = html.indexOf(`data-sec="${sec}"`);
    const next = html.indexOf('data-sec="', at + 10);
    const chunk = html.slice(at, next < 0 ? undefined : next);
    if (at >= 0 && !/<h2\b/.test(chunk)) problems.push(`section ${sec} has no <h2>`);
    if (at >= 0 && !chunk.includes('data-secnum')) problems.push(`section ${sec} has no number tab`);
  }
  // Every locked line and snapshot path the template asks for must exist.
  const data = templateData();
  for (const [, key] of html.matchAll(/data-locked="([^"]+)"/g)) if (!data.locked[key]) problems.push(`data-locked="${key}" is not in content/locked-lines.json`);
  for (const [, path] of html.matchAll(/data-snap="([^"]+)"/g)) {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data.snap);
    if (typeof v !== 'string') problems.push(`data-snap="${path}" has no text in the snapshot`);
  }
  // The gate's states: the passphrase form, the dead-link card, the wait card.
  for (const state of ['form', 'gone', 'wait']) if (!has(new RegExp(`data-gate="${state}"`))) problems.push(`the gate has no data-gate="${state}" card`);
  if (!has(/data-revision-links/)) problems.push('no data-revision-links (the client cannot move between revisions)');
  return problems;
}

function suiteContract() {
  const html = read('templates/proposal.html');
  const problems = contractProblems(html);
  const runtime = read('assets/js/proposal.js');
  for (const fn of ['applyConfig', 'initEffects', 'whenImagesReady']) {
    if (!new RegExp(`export (async )?function ${fn}\\b`).test(runtime)) problems.push(`runtime does not export ${fn}`);
    if (!runtime.includes(`window.${fn} = ${fn}`)) problems.push(`runtime does not expose window.${fn}`);
  }
  if (problems.length) return { status: FAIL, detail: problems };
  const detail = [`${SECTIONS.length} sections, ${REQUIRED_FIELDS.length} fields, ${REQUIRED_IMGS.length} image slots, ${REQUIRED_ROWS.length} row lists, ${REQUIRED_HOOKS.length} hooks`];
  if (PROVE) {
    // Remove each required hook in turn; the check must notice every time.
    const probes = [
      ...REQUIRED_IDS.map((id) => [`id="${id}"`, `id="x-${id}"`]),
      ...SECTIONS.map((s) => [`data-sec="${s}"`, `data-sec="x-${s}"`]),
      ...REQUIRED_FIELDS.map((f) => [`data-field="${f}"`, `data-field="x.${f}"`]),
      ...REQUIRED_IMGS.map((f) => [`data-img="${f}"`, `data-img="x.${f}"`]),
      ...REQUIRED_ROWS.map((f) => [`data-rows="${f}"`, `data-rows="x.${f}"`]),
      ...REQUIRED_HOOKS.map((h) => [h, 'x-' + h.slice(5)]),
      ['<h1 ', '<h3 '],
      ['data-locked="misfire"', 'data-locked="nope"'],
    ];
    const missed = probes.filter(([a, b]) => contractProblems(html.split(a).join(b)).length === 0).map(([a]) => a);
    if (missed.length) return { status: FAIL, detail: ['--prove: these removals went unnoticed', ...missed] };
    detail.push(`--prove: all ${probes.length} deliberate breakages caught`);
  }
  return { status: PASS, detail };
}

/* ---------------------------------------------------------------- brand */

const BRAND_PATTERNS = [/TEXC/, /0467\s?651\s?182/, /47\s?688\s?368\s?881/, /management@texc\.au/i, /George Scott/];

function suiteBrand() {
  const files = [
    ...walk('api', ['.js']), ...walk('lib', ['.js']).filter((f) => !['lib/brand.js', 'lib/editor-html.js', 'lib/signin-html.js', 'lib/template-data.js', 'lib/demo-fixture.js'].includes(f)),
    ...walk('assets/js', ['.js']), ...walk('scripts', ['.mjs', '.js']).filter((f) => f !== 'scripts/check.mjs'),
    ...walk('templates', ['.html']),
  ];
  const hits = [];
  for (const f of files) {
    const src = stripComments(read(f));
    for (const re of BRAND_PATTERNS) {
      const m = src.match(re);
      if (m) hits.push(`${f}: "${m[0]}" — use lib/brand.js`);
    }
  }
  const brandSrc = read('lib/brand.js');
  if (!/Object\.freeze\(\{/.test(brandSrc)) hits.push('lib/brand.js: BRAND must be frozen');
  try { BRAND.name = 'x'; } catch { /* frozen, as it should be */ }
  if (BRAND.name === 'x') hits.push('lib/brand.js: BRAND is writable');
  return hits.length ? { status: FAIL, detail: hits } : { status: PASS, detail: [`${files.length} machinery files clean`] };
}

/* ------------------------------------------------------------------ csp */

function suiteCsp() {
  const problems = [];
  let views;
  try { views = build({ write: false }); }
  catch (e) { return { status: FAIL, detail: [e.message] }; }
  const HTML_MODULES = new Set(['lib/editor-html.js', 'lib/signin-html.js']);
  for (const [name, body] of Object.entries(views)) {
    const isEditor = name === 'lib/editor-html.js';
    // Pages served by functions are string modules; check the page inside them.
    if (name.endsWith('.html') || HTML_MODULES.has(name)) {
      const html = HTML_MODULES.has(name) ? JSON.parse(body.slice(body.indexOf('= ') + 2, body.lastIndexOf(';'))) : body;
      try { checkView(name, html, { allowEditor: isEditor }); } catch (e) { problems.push(e.message); }
    }
    const committed = existsSync(resolve(ROOT, name)) ? read(name) : '';
    if (committed !== body) problems.push(`${name} is stale — run node scripts/build.mjs`);
  }
  const cfg = JSON.parse(read('vercel.json'));
  const all = (cfg.headers || []).find((h) => h.source === '/(.*)');
  const get = (k) => all && (all.headers.find((h) => h.key.toLowerCase() === k.toLowerCase()) || {}).value;
  const csp = get('Content-Security-Policy') || '';
  if (csp !== CLIENT_CSP) problems.push('vercel.json CSP differs from CLIENT_CSP in lib/csp.js — change one place, then copy it');
  for (const [label, policy] of [['client', csp], ['editor', EDITOR_CSP]]) {
    for (const must of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'"]) {
      if (!policy.includes(must)) problems.push(`${label} CSP lacks ${must}`);
    }
    for (const never of ["'unsafe-inline'", "'unsafe-eval'", '*']) if (policy.split(/\s+/).includes(never) || policy.includes(never + ';')) problems.push(`${label} CSP allows ${never}`);
  }
  // The editor may differ from the client page in exactly one way: blob: previews of a just-resized photo.
  if (EDITOR_CSP.replace("img-src 'self' blob:", "img-src 'self'") !== CLIENT_CSP) problems.push('EDITOR_CSP differs from CLIENT_CSP by more than img-src blob:');
  // pdf.js's worker parses untrusted PDFs: it carries its own, narrower policy (lib/csp.js WORKER_CSP).
  const vendor = (cfg.headers || []).find((h) => h.source === '/assets/vendor/(.*)');
  const vendorCsp = vendor && (vendor.headers.find((h) => h.key === 'Content-Security-Policy') || {}).value;
  if (vendorCsp !== WORKER_CSP) problems.push('vercel.json does not send WORKER_CSP with /assets/vendor/ (the pdf.js worker)');
  if (cfg.headers.indexOf(vendor) < cfg.headers.indexOf(all)) problems.push('the /assets/vendor/ header rule must come after /(.*) so its policy wins');
  for (const never of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:', '*']) if (WORKER_CSP.split(/[\s;]+/).includes(never)) problems.push(`the worker CSP allows ${never}`);
  if (!/connect-src 'self'( https:\/\/\S+)?;/.test(CLIENT_CSP) || !CLIENT_CSP.includes("worker-src 'self'")) problems.push('the client CSP must allow the viewer\'s worker and its fetch of the storage host, and nothing wider');
  if (get('X-Frame-Options') !== 'DENY') problems.push('X-Frame-Options must be DENY');
  if (get('X-Content-Type-Options') !== 'nosniff') problems.push('X-Content-Type-Options must be nosniff');
  if (get('Referrer-Policy') !== 'no-referrer') problems.push('Referrer-Policy must be no-referrer');
  if (!/noindex/.test(get('X-Robots-Tag') || '')) problems.push('X-Robots-Tag must carry noindex');
  if (!/Disallow:\s*\/\s*$/m.test(read('robots.txt'))) problems.push('robots.txt must disallow everything');
  if (!(cfg.regions || []).includes('syd1')) problems.push('functions must be pinned to syd1');
  return problems.length ? { status: FAIL, detail: problems } : { status: PASS, detail: ['views and the editor page clean and current; headers strict', 'vercel.json CSP = CLIENT_CSP; EDITOR_CSP adds only img-src blob:', 'the pdf.js worker runs under its own narrower policy (no eval, no blob:, own origin only)'] };
}

/* ---------------------------------------------------------- conventions */

function suiteConventions() {
  const files = [...walk('api', ['.js']), ...walk('lib', ['.js'])];
  const hits = [];
  for (const f of files) {
    const src = stripComments(read(f));
    if (/\bconsole\.\w+\s*\(/.test(src)) hits.push(`${f}: console.* in server code`);
    if (/select=\*/.test(src)) hits.push(`${f}: select=* — name the columns`);
    if (/\.end\([^)]*await\s+\w+\.text\(\)/.test(src) || /error:\s*await\s+\w+\.text\(\)/.test(src)) hits.push(`${f}: database error text echoed to a caller`);
  }
  return hits.length ? { status: FAIL, detail: hits } : { status: PASS, detail: [`${files.length} server files clean`] };
}

/* ---------------------------------------------------------------- quote */

function suiteQuote() {
  const fails = [];
  const eq = (a, b, what) => { if (a !== b) fails.push(`${what}: got ${a}, expected ${b}`); };
  // Fixed cases.
  eq(lineAmountCents({ qtyHundredths: 6000, rateCents: 15000 }), 900000, '60 h × $150');
  eq(lineAmountCents({ qtyHundredths: 250, rateCents: 15000 }), 37500, '2.5 h × $150');
  eq(lineAmountCents({ qtyHundredths: 1, rateCents: 50 }), 1, '0.01 × $0.50 rounds half up');
  eq(lineAmountCents({ qtyHundredths: 1, rateCents: 49 }), 0, '0.01 × $0.49 rounds down');
  eq(lineAmountCents({ rateCents: null }), null, 'at-cost line has no amount');
  const t = quoteTotals([{ id: 'a', qtyHundredths: 100, rateCents: 15 }], []);
  eq(t.gst, 2, 'GST on 15c is 1.5c → 2c');
  eq(t.total, 17, 'total on 15c');
  eq(quoteTotals([{ id: 'o', optional: true, qtyHundredths: 100, rateCents: 100 }], []).subtotal, 0, 'unticked optional excluded');
  eq(quoteTotals([{ id: 'o', optional: true, qtyHundredths: 100, rateCents: 100 }], ['o']).subtotal, 100, 'ticked optional included');
  eq(quoteTotals([{ id: 'x', rateCents: null }]).unpriced, 1, 'at-cost counted, not summed');
  eq(formatAUD(1122000), '$11,220.00', 'formatAUD');
  eq(formatAUD(5), '$0.05', 'formatAUD cents');
  eq(formatQty(250), '2.5', 'formatQty 2.5');
  eq(formatQty(6000), '60', 'formatQty 60');
  for (const bad of [{ qtyHundredths: 1.5, rateCents: 10 }, { qtyHundredths: -1, rateCents: 10 }, { qtyHundredths: 1, rateCents: 0.5 }]) {
    let threw = false;
    try { lineAmountCents(bad); } catch { threw = true; }
    if (!threw) fails.push(`accepted a non-integer or negative line ${JSON.stringify(bad)}`);
  }
  // Property test against an independent BigInt reference.
  let seed = 20261012;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ref = (lines, chosen) => {
    let sub = 0n;
    for (const l of lines) {
      if (l.optional && !chosen.includes(l.id)) continue;
      if (l.rateCents == null) continue;
      const p = BigInt(l.qtyHundredths) * BigInt(l.rateCents);
      sub += (p * 2n + 100n) / 200n;
    }
    const gst = (sub * 2n + 10n) / 20n;
    return { subtotal: Number(sub), gst: Number(gst), total: Number(sub + gst) };
  };
  for (let i = 0; i < 5000; i += 1) {
    const lines = Array.from({ length: 1 + rand(8) }, (_, k) => ({
      id: 'l' + k,
      qtyHundredths: rand(4) === 0 ? rand(10) : rand(100000),
      rateCents: rand(9) === 0 ? null : rand(2000000),
      optional: rand(4) === 0,
    }));
    const chosen = lines.filter((l) => l.optional && rand(2)).map((l) => l.id);
    const a = quoteTotals(lines, chosen);
    const b = ref(lines, chosen);
    if (a.subtotal !== b.subtotal || a.gst !== b.gst || a.total !== b.total) {
      fails.push(`random case ${i}: ${JSON.stringify(a)} vs reference ${JSON.stringify(b)}`);
      break;
    }
  }
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: ['fixed cases and 5,000 random quotes match an independent BigInt reference'] };
}

/* --------------------------------------------------------------- design */

function suiteDesign() {
  const hits = [];
  const colour = /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/i;
  for (const f of walk('assets/css', ['.css']).filter((x) => x !== 'assets/css/tokens.css')) {
    // Comments are blanked, not removed, so line numbers stay true.
    read(f).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
      const m = line.match(colour);
      if (m) hits.push(`${f}:${i + 1}: "${m[0]}" — use a token from tokens.css`);
    });
  }
  for (const f of walk('assets/js', ['.js'])) {
    stripComments(read(f)).split('\n').forEach((line, i) => {
      const m = line.match(/['"`]#[0-9a-f]{3,8}['"`]/i);
      if (m) hits.push(`${f}:${i + 1}: ${m[0]} — colour belongs in tokens.css`);
    });
  }
  return hits.length ? { status: FAIL, detail: hits } : { status: PASS, detail: ['no raw colour outside tokens.css'] };
}

/* ---------------------------------------------------------------- rules */

function suiteRules() {
  const fails = [];
  const ctx = { today: '2026-10-13', services: templateData().services, register: templateData().register, brand: BRAND.name };
  const demo = JSON.parse(read('fixtures/demo-proposal.json'));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const fields = (r) => r.blockers.map((b) => b.field);
  const expect = (cond, what) => { if (!cond) fails.push(what); };

  // An empty proposal: exactly what a new one lacks.
  const empty = runChecks({}, ctx);
  const want = ['meta.project', 'meta.siteLocality', 'client.company', 'client.contactName', 'client.email', 'meta.validUntil', 'cover.image', 'letter.body', 'understanding.paras', 'scope.services', 'risk.holdPoints', 'quote.lines'];
  for (const f of want) expect(fields(empty).includes(f), `empty proposal: no blocker for ${f}`);
  expect(!empty.ready, 'empty proposal: reported ready');

  // The demo as shipped: its client-visible documents have no files (it is fictional), and that is all.
  const bare = runChecks(demo, ctx);
  const clientCards = demo.attachments.filter((a) => a.visibility === 'client').length;
  expect(bare.blockers.length === clientCards && bare.blockers.every((b) => b.section === 'attachments' && /has no file/.test(b.message)),
    `demo without files: expected ${clientCards} "has no file" blockers, got ${bare.blockers.map((b) => b.message).join('; ')}`);

  // With a checked file on each: nothing to fix, only acknowledgements, and acknowledging them all makes it ready.
  const FILE = '00000000-0000-4000-8000-000000000001';
  const withFiles = (c) => { for (const a of c.attachments || []) if (a.visibility === 'client') a.file = FILE; return c; };
  const fctx = (status) => ({ ...ctx, files: { [FILE]: { status } } });
  const filed = withFiles(clone(demo));
  const d = runChecks(filed, fctx('clean'));
  expect(d.blockers.length === 0, `demo: ${d.blockers.length} blockers (${d.blockers.map((b) => b.message).join('; ')})`);
  expect(d.acks.length > 0 && !d.ready, 'demo: unacknowledged presets and prototype rates did not hold it back');
  const acked = runChecks({ ...clone(filed), acks: d.acks.map((a) => a.key) }, fctx('clean'));
  expect(acked.ready, 'demo: still not ready after every acknowledgement');

  // An acknowledgement belongs to the exact text: change the rate and it is asked again.
  const rerate = clone(filed); rerate.acks = d.acks.map((a) => a.key);
  rerate.quote.lines[0].rateCents += 100;
  expect(!runChecks(rerate, fctx('clean')).ready, 'changing an acknowledged rate did not ask again');

  // Files: only one that passed, or that an administrator released, goes to a client.
  for (const [status, blocks] of [['clean', false], ['override', false], ['rejected', true], ['cannot-verify', true], ['pending', true]]) {
    const r = runChecks(clone(filed), fctx(status));
    expect((r.blockers.length > 0) === blocks, `a file that is ${status}: expected ${blocks ? 'a blocker' : 'no blocker'}, got ${r.blockers.map((b) => b.message).join('; ') || 'none'}`);
  }
  expect(runChecks(clone(filed), fctx('override')).warnings.some((w) => /released by an administrator/.test(w.message)), 'a released file is not pointed out in the warnings');
  expect(runChecks(clone(filed), { ...ctx, files: {} }).blockers.some((b) => /no longer on this proposal/.test(b.message)), 'a card pointing at a file the proposal no longer has did not block');
  const onRequest = clone(demo); for (const a of onRequest.attachments) a.visibility = 'on-request';
  expect(runChecks(onRequest, ctx).blockers.length === 0, 'documents listed "on request" were asked for files');
  const hidden = clone(demo); hidden.layout.sections.find((x) => x.id === 'attachments').on = false;
  expect(runChecks(hidden, ctx).blockers.length === 0, 'a hidden attachments section still asked for files');
  const twin = withFiles(clone(demo)); twin.attachments[1].id = twin.attachments[0].id;
  expect(runChecks(twin, fctx('clean')).blockers.some((b) => /damaged/.test(b.message)), 'two cards with the same id did not block');

  // Each blocker, one case at a time.
  const cases = [
    ['a $confirm in a visible section', (c) => { c.meta.project = { $confirm: 'name' }; }, true],
    ['a $confirm in a hidden section', (c) => { c.params = { rows: { mic: { value: { $confirm: 'MIC' } } } }; }, false],
    ['terms switched off', (c) => { c.layout.sections.find((x) => x.id === 'terms').on = false; }, true],
    ['a pending service', (c) => { c.scope.services.push({ slug: 'remote-operations' }); }, true],
    ['a draft suite document offered', (c) => { c.docs.items.push({ id: 'TEXC12', provide: true }); }, true],
    ['valid-until in the past', (c) => { c.meta.validUntil = '2026-01-01'; }, true],
    ['an empty hazard row', (c) => { c.risk.hazards.push({}); }, true],
    ['a hazard without its control', (c) => { c.risk.hazards.push({ hazard: 'Flyrock' }); }, true],
    ['a photograph row with no image', (c) => { c.understanding.photos.push({ title: 'Bench' }); }, true],
    ['a new photograph with no alt text', (c) => { c.cover.image = { id: 'civil-excavator' }; }, true],
    ['a quote line with a bad quantity', (c) => { c.quote.lines[0].qtyHundredths = 'ten'; }, true],
    ['a limit with no source', (c) => { c.env = { ...(c.env || {}), limits: { rows: [{ parameter: 'PPV', limit: { $confirm: 'x' } }] } }; c.env.limits.rows[0].limit = '5 mm/s'; }, true],
  ];
  for (const [name, mutate, blocks] of cases) {
    const c = clone(filed);
    mutate(c);
    const r = runChecks(c, fctx('clean'));
    expect((r.blockers.length > 0) === blocks, `${name}: expected ${blocks ? 'a blocker' : 'no blocker'}, got ${r.blockers.length} (${r.blockers.map((b) => b.message).join('; ')})`);
  }

  // The sensitive-text scan: what it must catch, and ordinary proposal text it must leave alone.
  const catches = [
    ['-41.1837, 146.3615', 'coordinates'], ['41°10′S 146°21′E', 'dms'], ['The magazine is located behind the shed', 'magazine-location'],
    ['about 250 kg of emulsion per shot', 'explosive-quantity'], ['explosives up to 1.5 t on site', 'explosive-quantity'],
    ['vehicle rego to be supplied', 'vehicle'], ['delivery via Bass Highway departing 6:30 am', 'route-time'], ['stock levels checked weekly', 'stock-level'],
  ];
  for (const [text, rule] of catches) expect(scanText(text).some((h) => h.rule === rule), `sensitive scan missed ${rule}: "${text}"`);
  const passes = ['Ashgrove Heights', 'Stage 2 road and services corridor', '60 hr at $150.00', '14-day terms', 'Rock removed to a planned profile', 'Final inspection and blast assessment (HP3)', 'Day shift, Monday to Friday', 'About two weeks on site'];
  for (const text of passes) expect(scanText(text).length === 0, `sensitive scan flagged ordinary text: "${text}" (${scanText(text).map((h) => h.rule)})`);
  expect(localityWarning('12 Smith Street, Ashgrove') && localityWarning('Lot 4 Ridge Road') && !localityWarning('Ashgrove Heights'), 'locality check: street addresses vs suburbs');
  // And the demo itself carries no sensitive text that is not acknowledged.
  expect(!d.acks.some((a) => a.key.startsWith('sensitive:')), 'the demo trips the sensitive scan');

  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [`${want.length} required fields, ${cases.length} blocker cases, acknowledgement tied to text`, `sensitive scan: ${catches.length} catches, ${passes.length} ordinary lines left alone`] };
}

/* -------------------------------------------------------- content-sync */

function suiteContentSync() {
  const site = resolve(ROOT, '../texc');
  const r = spawnSync(process.execPath, [resolve(ROOT, 'scripts/texc-content-sync.mjs'), '--check'], { encoding: 'utf8' });
  if (r.status === 3) return { status: SKIP, detail: [r.stdout.trim().split('\n')[0]] };
  if (r.status !== 0) return { status: FAIL, detail: [(r.stderr || r.stdout).trim()] };
  const detail = [r.stdout.trim()];
  // Token drift: every token both files define must have the same value.
  const globals = readFileSync(resolve(site, 'app/globals.css'), 'utf8');
  const ours = read('assets/css/tokens.css').split('@media')[0];
  const parse = (css) => {
    const map = new Map();
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) if (!map.has(m[1])) map.set(m[1], m[2].replace(/\s+/g, ' ').replace(/\s*\/\*.*$/, '').trim());
    return map;
  };
  const theirs = parse(globals.replace(/\/\*[\s\S]*?\*\//g, ''));
  const mine = parse(ours.replace(/\/\*[\s\S]*?\*\//g, ''));
  const norm = (v) => v.toLowerCase().replace(/\s+/g, '').replace(/\(\s*/g, '(').replace(/0\.(\d)/g, '.$1');
  const drift = [];
  let compared = 0;
  for (const [k, v] of mine) {
    if (!theirs.has(k) || k.startsWith('--font-')) continue; // fonts differ by design until the licence is confirmed
    compared += 1;
    if (norm(theirs.get(k)) !== norm(v)) drift.push(`${k}: website ${theirs.get(k)} · here ${v}`);
  }
  if (drift.length) return { status: FAIL, detail: ['token drift from texc/app/globals.css', ...drift] };
  detail.push(`${compared} shared tokens match the website`);
  // Library wording derived from 2 Chalmers Lane must still be TEXC's exact words.
  const lib = JSON.parse(read('content/library.seed.json'));
  const chalmers = 'documents/projects/2-chalmers-lane-devonport/content/';
  const sourceText = ['project-understanding.yml', 'preliminary-risk-assessment.yml']
    .map((f) => readFileSync(resolve(site, chalmers, f), 'utf8')).join('\n').replace(/''/g, "'").replace(/\s+/g, ' ');
  const strings = [];
  const collect = (v) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  for (const item of [...lib.hazardPresets, ...lib.methodPresets, ...lib.holdPointPresets, lib.siteConditions, lib.constraints, lib.riskIntro, lib.riskReview]) {
    if (!/chalmers/i.test(String(item.source || ''))) continue;
    for (const key of ['rows', 'steps', 'items', 'paras', 'intro', 'callouts']) if (item[key]) collect(item[key]);
  }
  const words = strings.filter((x) => x.trim() && !/^(?:open|HP\d)$/.test(x));
  const reFor = (x) => new RegExp(x.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{client\\\}/g, '(?:Beardwood Contractors|Beardwood)')).join('\\s+'));
  const altered = words.filter((x) => !reFor(x).test(sourceText));
  if (altered.length) return { status: FAIL, detail: ['library lines that are no longer TEXC\'s exact Chalmers Lane wording:', ...altered.map((x) => `  "${x.slice(0, 90)}${x.length > 90 ? '…' : ''}"`)] };
  detail.push(`${words.length} Chalmers-derived library lines found word for word in the source`);
  return { status: PASS, detail };
}

/* ------------------------------------------------------------ browser */

let browserCtx = null;
async function browserSession() {
  if (browserCtx) return browserCtx;
  const { loadPlaywright } = await import('./lib/browser.mjs');
  const pw = await loadPlaywright();
  if (!pw) return null;
  const { startServer } = await import('./demo/serve.mjs');
  const port = 4390 + Math.floor(Math.random() * 400);
  const server = await startServer({ port });
  const browser = await pw.chromium.launch();
  browserCtx = { pw, server, browser, base: `http://127.0.0.1:${port}` };
  return browserCtx;
}

async function openPage(path, { width = 1440, height = 900, mode } = {}) {
  const ctx = await browserSession();
  const page = await ctx.browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('script error: ' + e.message));
  await page.goto(ctx.base + path, { waitUntil: 'networkidle' });
  if (mode) await page.evaluate((m) => { document.documentElement.dataset.mode = m; }, mode);
  return { page, problems };
}

async function suiteRender() {
  if (!(await browserSession())) return { status: SKIP, detail: ['Playwright not found'] };
  const detail = [];
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const { page, problems } = await openPage('/demo', { width: w, height: h });
    await page.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 15000 });
    const stats = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      sections: document.querySelectorAll('#main > [data-sec]:not([hidden])').length,
      leaked: /\{\{|\{phone|\{name|undefined|NaN|\[object Object\]/.test(document.body.innerText),
      brokenImgs: [...document.images].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.src),
      emptyAlt: [...document.querySelectorAll('img[src]')].filter((i) => !i.closest('[hidden]') && i.getAttribute('alt') === '' && !i.closest('[aria-hidden]')).length,
    }));
    if (stats.overflow > 0) problems.push(`${w}px: page is ${stats.overflow}px wider than the screen`);
    if (stats.leaked) problems.push(`${w}px: a raw token, undefined or NaN reached the page`);
    if (stats.brokenImgs.length) problems.push(`${w}px: broken images ${stats.brokenImgs.join(', ')}`);
    if (stats.emptyAlt) problems.push(`${w}px: ${stats.emptyAlt} visible image(s) with empty alt`);
    await page.close();
    if (problems.length) return { status: FAIL, detail: problems };
    detail.push(`${w}px: ${stats.sections} sections, no console errors, no CSP violations, no overflow`);
  }
  return { status: PASS, detail };
}

function confirmify(cfg) {
  // Replace every user-visible string with a $confirm object.
  const walkCfg = (v, key) => {
    if (typeof v === 'string' && !['id', 'slug', 'basis', 'party', 'status', 'docType', 'personId', 'category', 'visibility', 'code'].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { $confirm: `fill ${key}` };
    if (Array.isArray(v)) return v.map((x) => walkCfg(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkCfg(x, k)]));
    return v;
  };
  const out = walkCfg(cfg, '');
  out.layout = cfg.layout;
  return out;
}

async function suiteConfirm() {
  if (!(await browserSession())) return { status: SKIP, detail: ['Playwright not found'] };
  const fixture = JSON.parse(read('fixtures/demo-proposal.json'));
  const cfg = confirmify(fixture);
  const fails = [];
  // Published: not one CONFIRM, anywhere in the rendered text or attributes.
  const pub = await openPage('/p/check');
  await pub.page.evaluate((c) => window.applyConfig(c), cfg);
  const leaked = await pub.page.evaluate(() => ({
    text: /CONFIRM|\$confirm/.test(document.body.innerText),
    html: /\$confirm|CONFIRM —/.test(document.getElementById('main').innerHTML),
    marks: document.querySelectorAll('mark.confirm').length,
  }));
  if (leaked.text || leaked.html || leaked.marks) fails.push(`published mode leaked CONFIRM (text ${leaked.text}, html ${leaked.html}, marks ${leaked.marks})`);
  fails.push(...pub.problems);
  await pub.page.close();
  // Editor: the same config shows red CONFIRM tags so nothing is missed.
  const ed = await openPage('/p/check', { mode: 'editor' });
  await ed.page.evaluate((c) => window.applyConfig(c), cfg);
  const marks = await ed.page.evaluate(() => document.querySelectorAll('mark.confirm').length);
  if (marks < 10) fails.push(`editor mode shows only ${marks} CONFIRM tags`);
  await ed.page.close();
  return fails.length
    ? { status: FAIL, detail: fails }
    : { status: PASS, detail: [`published page shows no CONFIRM; editor mode shows ${marks} tags`, 'the server-side publish refusal is proved by the refusals suite'] };
}

async function suitePrint() {
  if (!(await browserSession())) return { status: SKIP, detail: ['Playwright not found'] };
  const { page, problems } = await openPage('/demo', { width: 1200, height: 900 });
  await page.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 15000 });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.evaluate(() => window.whenImagesReady(document, 8000));
  const blank = await page.evaluate(() => [...document.querySelectorAll('#main > [data-sec]:not([hidden])')]
    .filter((s) => { const r = s.getBoundingClientRect(); const cs = getComputedStyle(s); return r.height < 40 || cs.opacity !== '1' || s.innerText.trim().length < 20; })
    .map((s) => s.id));
  const hiddenReveals = await page.evaluate(() => [...document.querySelectorAll('[data-reveal]')].filter((n) => !n.closest('[hidden]') && getComputedStyle(n).opacity !== '1').length);
  const headings = await page.evaluate(() => [...document.querySelectorAll('#main > [data-sec]:not([hidden]) h2')].map((h) => h.textContent.trim()).filter((t) => t && t !== 'Contact'));
  const out = resolve(ROOT, 'demo-out');
  mkdirSync(out, { recursive: true });
  const pdfPath = resolve(out, 'demo-proposal-A4.pdf');
  writeFileSync(pdfPath, await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  await page.close();
  const fails = [...problems];
  if (blank.length) fails.push(`sections that would print blank: ${blank.join(', ')}`);
  if (hiddenReveals) fails.push(`${hiddenReveals} reveal blocks still invisible in print`);
  let pages = 0;
  try {
    const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
    pages = (text.match(/\f/g) || []).length;
    const flat = text.replace(/\s+/g, ' ').toUpperCase();
    const missing = headings.filter((h) => !flat.includes(h.toUpperCase().replace(/\s+/g, ' ')));
    if (missing.length) fails.push(`headings missing from the PDF text: ${missing.join(', ')}`);
    if (!flat.includes(`ABN ${BRAND.abn}`)) fails.push('the ABN is missing from the printed footer');
  } catch {
    return { status: SKIP, detail: ['pdftotext not available to read the PDF back'] };
  }
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [`${headings.length} section headings found in a ${pages}-page A4 PDF (demo-out/demo-proposal-A4.pdf)`] };
}

/* ----------------------------------------------------------- attachments */

function suiteAttachments() {
  const fails = [];
  const notes = [];
  const skips = [];
  // 1. Each way a file can be safe or not, built in code.
  for (const [name, f] of Object.entries(PDF_FIXTURES)) {
    const started = Date.now();
    const r = inspectPdf(f.bytes());
    const ms = Date.now() - started;
    if (r.status !== f.status || r.overridable !== f.overridable) fails.push(`${name}: ${r.status}${r.overridable ? ' (overridable)' : ''}, expected ${f.status}${f.overridable ? ' (overridable)' : ''}`);
    if (f.pages !== undefined && r.pages !== f.pages) fails.push(`${name}: counted ${r.pages} pages, expected ${f.pages}`);
    // Work is bounded: the ones that hit a budget expand hundreds of MB to prove it, the rest are instant.
    if (ms > (f.slow ? 15000 : 1500)) fails.push(`${name}: took ${ms} ms`);
  }
  notes.push(`${Object.keys(PDF_FIXTURES).length} built files each judged as expected (clean, refused, or cannot verify; and whether an administrator may release it)`);

  // 2. It never throws, whatever the bytes: a clean file, damaged at random.
  const base = PDF_FIXTURES['clean, three pages'].bytes();
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 400; i += 1) {
    const b = Buffer.from(base);
    for (let k = 0; k < 1 + (i % 12); k += 1) b[8 + (rand() % (b.length - 8))] = rand() & 255;
    const cut = i % 5 === 0 ? b.subarray(0, 8 + (rand() % (b.length - 8))) : b;
    try {
      const r = inspectPdf(cut);
      if (!['clean', 'rejected', 'cannot-verify'].includes(r.status)) { fails.push(`a damaged file got status ${r.status}`); break; }
    } catch (e) { fails.push(`a damaged file made the check throw: ${e.message}`); break; }
  }
  notes.push('400 randomly damaged copies: never threw, always a verdict');

  // 3. The vendored pdf.js is exactly the published package (assets/vendor/pdfjs/README.md).
  const viewerSrc = read('assets/js/pdf-viewer.js');
  const version = (/\/assets\/vendor\/pdfjs\/([0-9.]+)\//.exec(viewerSrc) || [])[1];
  const vdir = version ? resolve(ROOT, `assets/vendor/pdfjs/${version}`) : '';
  if (!version || !existsSync(join(vdir, 'SHA256SUMS'))) fails.push('assets/js/pdf-viewer.js does not point at a vendored pdf.js with a SHA256SUMS');
  else {
    const listed = new Map(read(`assets/vendor/pdfjs/${version}/SHA256SUMS`).trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f.replace(/^\.\//, ''), h]; }));
    const present = walk(`assets/vendor/pdfjs/${version}`, ['']).map((f) => relative(vdir, resolve(ROOT, f))).filter((f) => f !== 'SHA256SUMS');
    for (const f of present) {
      const want = listed.get(f);
      if (!want) fails.push(`assets/vendor/pdfjs/${version}/${f} is not in SHA256SUMS`);
      else if (createHash('sha256').update(readFileSync(join(vdir, f))).digest('hex') !== want) fails.push(`assets/vendor/pdfjs/${version}/${f} differs from SHA256SUMS`);
    }
    for (const f of listed.keys()) if (!present.includes(f)) fails.push(`assets/vendor/pdfjs/${version}/${f} is listed but missing`);
    notes.push(`pdf.js ${version}: all ${listed.size} vendored files match SHA256SUMS`);
  }

  // 4. TEXC's own suite PDFs, against a second parser's reading of them, then flattened.
  const dir = resolve(ROOT, '../texc/documents/exemplars/pdf');
  const has = (cmd) => spawnSync(cmd, ['-v'], { encoding: 'utf8' }).status !== null;
  // The second opinion on scripts is pypdf (scripts/lib/pdf-js-oracle.py), a different parser.
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.pdf')).sort() : [];
  const oracle = files.length ? spawnSync('python3', ['-I', resolve(ROOT, 'scripts/lib/pdf-js-oracle.py'), ...files.map((n) => join(dir, n))], { encoding: 'utf8' }) : null;
  let opinion = null;
  try { opinion = oracle && oracle.status === 0 ? JSON.parse(oracle.stdout) : null; } catch { opinion = null; }
  if (!existsSync(dir)) skips.push('TEXC suite PDFs not checked: no sibling ../texc checkout');
  else if (!has('pdfinfo') || !has('pdftocairo')) skips.push('TEXC suite PDFs not checked: poppler (pdfinfo, pdftocairo) is not installed');
  else if (!opinion) skips.push('TEXC suite PDFs not checked: no second opinion (python3 with pypdf is not installed)');
  else {
    const tmp = resolve(ROOT, 'demo-out/attachments-check');
    mkdirSync(tmp, { recursive: true });
    let refused = 0;
    let flattened = 0;
    for (const name of files) {
      const file = join(dir, name);
      const bytes = readFileSync(file);
      const r = inspectPdf(bytes);
      const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout || '';
      const pages = Number((/^Pages:\s+(\d+)/m.exec(info) || [])[1]);
      const js = opinion[file].js === true;
      if (js && r.status === 'clean') fails.push(`${name}: pypdf finds JavaScript, the check passed it`);
      if (!js && r.status !== 'clean') fails.push(`${name}: pypdf finds no JavaScript, the check said ${r.status} (${r.reasons.join(' ')})`);
      if (r.status === 'rejected') { refused += 1; if (!r.overridable) fails.push(`${name}: refused outright — an administrator could not release it`); }
      if (r.pages !== pages) fails.push(`${name}: counted ${r.pages} pages, poppler says ${pages}`);
      const flat = join(tmp, name.replace(/\.pdf$/, '-flattened.pdf'));
      const out = spawnSync('pdftocairo', ['-pdf', file, flat], { encoding: 'utf8' });
      if (out.status !== 0) { fails.push(`${name}: could not be flattened for the check`); continue; }
      const f = inspectPdf(readFileSync(flat));
      if (f.status !== 'clean') fails.push(`${name}: its flattened copy was ${f.status} (${f.reasons.join(' ')})`);
      else if (f.pages !== pages) fails.push(`${name}: its flattened copy counted ${f.pages} pages, not ${pages}`);
      else flattened += 1;
    }
    notes.push(`TEXC suite PDFs: ${refused} of ${files.length} refused for JavaScript, exactly the ones pypdf finds scripts in; page counts agree with poppler; all ${flattened} flattened copies clean`);
  }
  if (fails.length) return { status: FAIL, detail: fails };
  return { status: skips.length ? SKIP : PASS, detail: [...notes, ...skips] };
}

/* ---------------------------------------------------------------- run */

const SUITES = {
  contract: suiteContract, brand: suiteBrand, csp: suiteCsp, conventions: suiteConventions, quote: suiteQuote,
  design: suiteDesign, rules: suiteRules, attachments: suiteAttachments,
  confirm: suiteConfirm, render: suiteRender, print: suitePrint, 'content-sync': suiteContentSync,
  schema: suiteSchema, envelope: () => suiteEnvelope({ browserSession }), refusals: suiteRefusals, editor: suiteEditor, flow: suiteFlow,
};

const wanted = args.filter((a) => !a.startsWith('--'));
const names = wanted.length ? wanted : Object.keys(SUITES);
for (const n of names) if (!SUITES[n]) { console.error(`Unknown suite "${n}". Suites: ${Object.keys(SUITES).join(', ')}`); process.exit(2); }

let worst = 0;
for (const n of names) {
  let r;
  try { r = await SUITES[n](); }
  catch (e) { r = { status: FAIL, detail: ['could not run: ' + e.message] }; }
  const mark = r.status === PASS ? 'PASS' : r.status === SKIP ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${n}`);
  for (const d of r.detail || []) console.log(`      ${d}`);
  if (r.status === FAIL) worst = 1;
  else if (r.status === SKIP && worst === 0) worst = 3;
}
if (browserCtx) { await browserCtx.browser.close(); browserCtx.server.close(); }
await closeServerSuites();
console.log(worst === 0 ? '\nAll checks passed.' : worst === 3 ? '\nNothing failed, but something was NOT CHECKED (see SKIP above).' : '\nChecks FAILED.');
process.exit(worst);

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
 *   editor        staff walk through the editor: edit, rows, undo, CONFIRM, photos,
 *                 checklist, autosave across a reload, phone layout   (browser)
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
import { build, checkView, templateData } from './build.mjs';
import { BRAND } from '../lib/brand.js';
import { CLIENT_CSP, EDITOR_CSP } from '../lib/csp.js';
import { quoteTotals, lineAmountCents, formatAUD, formatQty } from '../assets/js/money.js';
import { runChecks } from '../assets/js/checks.js';
import { scanText, localityWarning } from '../assets/js/sensitive.js';

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
const REQUIRED_IDS = ['main', 'topbar', 'pbar', 'index', 'sheet', 'flt', 'superseded', 'demo-chip', 'index-toggle', 'brand-data', 'template-data'];
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
  // Reserved ids the gate (Phase 3) will own.
  for (const id of ['gate', 'gate-form', 'gate-pass']) if (has(new RegExp(`\\sid="${id}"`))) problems.push(`#${id} is reserved for the gate`);
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
    ...walk('api', ['.js']), ...walk('lib', ['.js']).filter((f) => f !== 'lib/brand.js' && f !== 'lib/editor-html.js'),
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
  for (const [name, body] of Object.entries(views)) {
    const isEditor = name === 'lib/editor-html.js';
    // The editor is a string module; check the page inside it, under the editor's rules.
    const html = isEditor ? JSON.parse(body.slice(body.indexOf('= ') + 2, body.lastIndexOf(';'))) : body;
    try { checkView(name, html, { allowEditor: isEditor }); } catch (e) { problems.push(e.message); }
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
  if (get('X-Frame-Options') !== 'DENY') problems.push('X-Frame-Options must be DENY');
  if (get('X-Content-Type-Options') !== 'nosniff') problems.push('X-Content-Type-Options must be nosniff');
  if (get('Referrer-Policy') !== 'no-referrer') problems.push('Referrer-Policy must be no-referrer');
  if (!/noindex/.test(get('X-Robots-Tag') || '')) problems.push('X-Robots-Tag must carry noindex');
  if (!/Disallow:\s*\/\s*$/m.test(read('robots.txt'))) problems.push('robots.txt must disallow everything');
  if (!(cfg.regions || []).includes('syd1')) problems.push('functions must be pinned to syd1');
  return problems.length ? { status: FAIL, detail: problems } : { status: PASS, detail: ['views and the editor page clean and current; headers strict', 'vercel.json CSP = CLIENT_CSP; EDITOR_CSP adds only img-src blob:'] };
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

  // The demo: nothing to fix, only acknowledgements, and acknowledging them all makes it ready.
  const d = runChecks(demo, ctx);
  expect(d.blockers.length === 0, `demo: ${d.blockers.length} blockers (${d.blockers.map((b) => b.message).join('; ')})`);
  expect(d.acks.length > 0 && !d.ready, 'demo: unacknowledged presets and prototype rates did not hold it back');
  const acked = runChecks({ ...clone(demo), acks: d.acks.map((a) => a.key) }, ctx);
  expect(acked.ready, 'demo: still not ready after every acknowledgement');

  // An acknowledgement belongs to the exact text: change the rate and it is asked again.
  const rerate = clone(demo); rerate.acks = d.acks.map((a) => a.key);
  rerate.quote.lines[0].rateCents += 100;
  expect(!runChecks(rerate, ctx).ready, 'changing an acknowledged rate did not ask again');

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
    const c = clone(demo);
    mutate(c);
    const r = runChecks(c, ctx);
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
    : { status: PASS, detail: [`published page shows no CONFIRM; editor mode shows ${marks} tags`, 'server-side publish refusal arrives with Phase 3'] };
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

/* --------------------------------------------------------------- editor */

async function suiteEditor() {
  if (!(await browserSession())) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { page, problems } = await openPage('/editor');
  page.on('dialog', (d) => d.accept());
  const cfg = () => page.evaluate(() => window.__editor.state.cfg);
  const blockers = () => page.evaluate(() => window.__editor.state.checks.blockers.map((b) => b.message));
  const settle = () => page.waitForTimeout(350); // past the badge debounce and a preview frame
  await page.waitForFunction(() => window.__editor && document.querySelectorAll('.ed-panel').length === 20, null, { timeout: 15000 });
  expect(await page.evaluate(() => window.__editor.state.checks.blockers.length) >= 12, 'a new proposal does not list what it lacks');
  await page.evaluate(async () => { const r = await fetch('/fixtures/demo-proposal.json'); window.__editor.load(await r.json(), 'demo'); });
  await settle();

  // Typing goes straight to the page.
  await page.fill('[data-path="meta.project"] input', 'Controlled rock removal, Stage 3');
  await settle();
  expect(await page.textContent('.cover-title span') === 'Controlled rock removal, Stage 3', 'typing the project did not update the cover');
  expect(await page.textContent('.topbar-project') === 'Controlled rock removal, Stage 3', 'typing the project did not update the top bar');

  // Show / hide, and reorder from the keyboard.
  await page.click('.ed-panel[data-sec="about"] .ed-switch');
  await page.click('.ed-panel[data-sec="params"] .ed-switch');
  await settle();
  expect(await page.evaluate(() => document.getElementById('about').hidden && !document.getElementById('params').hidden), 'the show/hide switches did not reach the page');
  await page.focus('.ed-panel[data-sec="site"] .ed-handle');
  await page.keyboard.press('Alt+ArrowUp');
  await settle();
  const order = (await cfg()).layout.sections.map((x) => x.id);
  const pageOrder = await page.$$eval('#main > [data-sec]', (els) => els.map((e) => e.id));
  expect(order.indexOf('site') < order.indexOf('scope') && pageOrder.indexOf('site') < pageOrder.indexOf('scope'), 'Alt+Up did not move Site above Scope on the page');
  expect(await page.evaluate(() => document.activeElement?.closest('.ed-panel')?.dataset.sec === 'site'), 'focus left the moved handle');
  expect(order[0] === 'cover' && order.at(-1) === 'contact' && order.at(-2) === 'accept', 'pinned sections moved');

  // Rows: delete with undo, add, and an empty row blocks publishing.
  await page.click('.ed-panel[data-sec="risk"] .ed-panel-toggle');
  await settle();
  const n0 = (await cfg()).risk.hazards.length;
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] .ed-row .ed-danger >> nth=0');
  await settle();
  expect((await cfg()).risk.hazards.length === n0 - 1, 'delete did not remove the hazard');
  await page.click('#ed-toast button');
  await settle();
  expect((await cfg()).risk.hazards.length === n0, 'Undo did not restore the hazard');
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] > .ed-rows-tools > button >> nth=0');
  await settle();
  expect((await cfg()).risk.hazards.length === n0 + 1, 'Add did not append a hazard');
  expect((await blockers()).some((m) => /Hazard \d+ is empty/.test(m)), 'an empty hazard row did not block publishing');
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] .ed-row .ed-danger >> nth=-1');
  await settle();

  // CONFIRM: flagging keeps what was typed, the preview shows the tag, confirming restores it.
  await page.click('.ed-panel[data-sec="letter"] .ed-panel-toggle');
  await settle();
  const greet = '.ed-panel[data-sec="letter"] [data-path="letter.greetingName"]';
  const before = (await cfg()).letter.greetingName;
  await page.click(`${greet} .ed-flag`);
  await settle();
  const flagged = (await cfg()).letter.greetingName;
  expect(flagged && flagged.$confirm && flagged.suggested === before, 'flagging CONFIRM lost the text that was there');
  expect(await page.isVisible('#letter mark.confirm'), 'a CONFIRM did not show in the preview');
  expect((await blockers()).some((m) => m.startsWith('Unconfirmed')), 'a CONFIRM did not block publishing');
  await page.click(`${greet} .ed-linkbtn:has-text("Confirmed")`);
  await settle();
  expect((await cfg()).letter.greetingName === before && !(await page.isVisible('#letter mark.confirm')), '"Confirmed — use this text" did not restore it');

  // Photographs: a new choice starts without the old alt text; an upload is resized and kept locally.
  await page.click('[data-path="cover.image"] button:has-text("Change")');
  await page.click('dialog .ed-photo >> nth=1');
  await settle();
  expect(!(await cfg()).cover.image.alt, 'a new photograph inherited the previous alt text');
  expect((await blockers()).some((m) => /no alt text/.test(m)), 'a photograph without alt text did not block publishing');
  await page.click('[data-path="cover.image"] button:has-text("Change")');
  await page.waitForSelector('dialog .ed-photo');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--gold'); g.fillRect(0, 0, 2400, 1600); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('dialog input[type=file]', { name: 'site-walk.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => /^u-/.test(window.__editor.state.cfg.cover?.image?.id || ''), null, { timeout: 15000 });
  await page.fill('[data-path="cover.image"] input >> nth=0', 'Rock face at the Stage 3 corridor');
  await settle();
  const up = await page.evaluate(() => { const id = window.__editor.state.cfg.cover.image.id; return { m: window.__editor.state.cfg.media[id], src: document.querySelector('img[data-img="cover.image"]').currentSrc }; });
  expect(up.m && up.m.local && Math.max(...up.m.widths) <= 2000 && up.src.startsWith('blob:'), `an upload was not resized and previewed (${JSON.stringify(up.m)})`);

  // The checklist, ticked through, reaches "Ready" on the demo as loaded.
  await page.evaluate(async () => { const r = await fetch('/fixtures/demo-proposal.json'); const c = await r.json(); c.meta.project = 'Controlled rock removal, Stage 3'; window.__editor.load(c, 'demo'); });
  await settle();
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  const boxes = await page.$$('dialog .ed-ack input');
  for (const b of boxes) await b.check();
  expect(/Ready to publish/.test(await page.textContent('dialog .ed-verdict')), 'acknowledging everything did not reach "Ready to publish"');
  await page.click('dialog .ed-dialog-head button');

  // Autosave survives a reload; print never shows the drawer.
  await page.keyboard.press('Control+s');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__editor, null, { timeout: 15000 });
  await settle();
  expect(await page.textContent('.cover-title span') === 'Controlled rock removal, Stage 3', 'the draft did not survive a reload');
  expect((await cfg()).acks?.length === boxes.length, 'acknowledgements did not survive a reload');
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('ed')).display === 'none' && parseFloat(getComputedStyle(document.body).paddingLeft) === 0), 'the drawer shows in print');
  await page.close();
  fails.push(...problems);

  // Phone: a full-screen sheet with Edit / Preview, nothing overlapping or wider than the screen.
  const phone = await openPage('/editor', { width: 390, height: 844 });
  await phone.page.waitForFunction(() => window.__editor, null, { timeout: 15000 });
  await phone.page.evaluate(async () => { const r = await fetch('/fixtures/demo-proposal.json'); window.__editor.load(await r.json(), 'demo'); });
  await phone.page.waitForTimeout(350);
  const lay = await phone.page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const a = r('.ed-brand'), b = r('.ed-top-actions');
    return { drawer: r('#ed').width, overlap: a.right > b.left + 1, wide: document.getElementById('ed').scrollWidth > window.innerWidth };
  });
  expect(lay.drawer === 390 && !lay.overlap && !lay.wide, `phone layout: drawer ${lay.drawer}px, header overlap ${lay.overlap}, too wide ${lay.wide}`);
  await phone.page.click('#ed-mode-preview');
  expect(await phone.page.evaluate(() => getComputedStyle(document.getElementById('ed')).display === 'none' && document.documentElement.scrollWidth <= window.innerWidth), 'Preview did not show the page full width');
  await phone.page.click('#ed-mode-edit');
  expect(await phone.page.isVisible('#ed'), 'Edit did not bring the sheet back');
  await phone.page.close();
  fails.push(...phone.problems);

  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [
    'typing, show/hide, keyboard reorder, rows with undo, CONFIRM flag and restore',
    'photo choice clears alt, upload resized and previewed, checklist reaches Ready',
    'autosave survives a reload; no drawer in print; phone Edit/Preview with no overlap',
  ] };
}

/* ---------------------------------------------------------------- run */

const SUITES = {
  contract: suiteContract, brand: suiteBrand, csp: suiteCsp, conventions: suiteConventions, quote: suiteQuote,
  design: suiteDesign, rules: suiteRules,
  confirm: suiteConfirm, render: suiteRender, print: suitePrint, editor: suiteEditor, 'content-sync': suiteContentSync,
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
console.log(worst === 0 ? '\nAll checks passed.' : worst === 3 ? '\nNothing failed, but something was NOT CHECKED (see SKIP above).' : '\nChecks FAILED.');
process.exit(worst);

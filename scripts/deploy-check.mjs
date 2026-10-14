#!/usr/bin/env node
/**
 * A DEPLOYED copy, checked from outside the way a visitor meets it: the
 * things the local servers can only stand in for (docs/open-items.md D1, D3
 * and the header half of D5; docs/handover.md §3).
 *
 *   node scripts/deploy-check.mjs --url https://<deployment>.vercel.app [--production]
 *
 *   VERCEL_PROTECTION_BYPASS  for a preview behind Vercel's deployment
 *                             protection: its "Protection Bypass for
 *                             Automation" secret
 *   STAFF_SESSION             a signed-in staff session (the value of the
 *                             __Host-texc_sess cookie) adds the editor and
 *                             the dashboard
 *
 * GET requests only. Nothing is created and no proposal, account or file is
 * touched: the client endpoints are asked with the wrong method, which they
 * refuse before they reach the database. Attaching, viewing and downloading a
 * document (D4, the rest of D5) write to storage, and stay a person's job.
 *
 * Exit 0 everything held; 1 something is wrong; 2 the deployment could not
 * be reached; 3 nothing wrong, but something NOT CHECKED.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_CSP, EDITOR_CSP, WORKER_CSP } from '../lib/csp.js';
import { SESSION_COOKIE } from '../lib/accounts.js';
import { SIGNIN_HTML } from '../lib/signin-html.js';
import { DASHBOARD_HTML } from '../lib/dashboard-html.js';
import { LIBRARY_HTML } from '../lib/library-html.js';
import { EDITOR_HTML } from '../lib/editor-html.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const local = (rel) => readFileSync(resolve(ROOT, rel.replace(/^\//, '')));

// A storage origin in a policy, whichever it is: the wildcard until the
// project exists, the project's own once narrowed (D3), or the local stand-in.
const STORAGE = /https:\/\/(\*|[a-z0-9]+)\.supabase\.co|http:\/\/127\.0\.0\.1:\d+/g;
const shape = (p) => String(p || '').replace(STORAGE, '<storage>');

/** Never a URL: the editor and its library, the website snapshot, the schema, the source. */
const PRIVATE = [
  '/lib/editor-html.js', '/lib/template-data.js', '/lib/brand.js', '/lib/vault.js',
  '/content/library.seed.json', '/content/texc-snapshot.json', '/content/locked-lines.json',
  '/templates/proposal.html', '/fixtures/demo-proposal-revB.json', '/supabase/schema.sql',
  '/scripts/build.mjs', '/docs/architecture.md', '/package.json', '/vercel.json',
  '/.env', '/.env.example', '/.git/config', '/CLAUDE.md',
];
/** Served on a preview only (DEMO_PUBLIC=1), never in production. */
const DEMO_ONLY = ['/demo', '/views/demo.html', '/fixtures/demo-proposal.json'];

const TYPES = { '.css': /^text\/css/, '.js': /javascript/, '.mjs': /javascript/, '.woff2': /^font\/woff2/, '.svg': /^image\/svg\+xml/, '.webp': /^image\/webp/, '.png': /^image\/png/, '.wasm': /^application\/wasm/ };

export async function runDeployCheck({ url, production = false, bypass = '', session = '', fetchImpl = fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  const held = [], wrong = [], notes = [], notChecked = [];
  const https = base.startsWith('https://');
  const vercel = JSON.parse(local('vercel.json'));
  const shared = Object.fromEntries((vercel.headers.find((h) => h.source === '/(.*)') || { headers: [] }).headers.map((h) => [h.key.toLowerCase(), h.value]));
  const seenStorage = new Set();

  const get = async (path, { cookie = '', manual = false } = {}) => {
    // Vercel can inject its toolbar into a preview's pages; this asks it not
    // to, so the bytes compared are the deployment's own.
    const headers = { 'user-agent': 'deploy-check', 'x-vercel-skip-toolbar': '1' };
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
    if (cookie) headers.cookie = cookie;
    const r = await fetchImpl(base + path, { headers, redirect: manual ? 'manual' : 'follow' });
    return { status: r.status, h: (k) => r.headers.get(k), body: Buffer.from(await r.arrayBuffer()) };
  };
  // Every page and file carries the shared headers, exactly as vercel.json sends them.
  const sharedHeaders = (label, r) => {
    // A preview may also get Vercel's own noindex, so that one need only say both words.
    const ok = (k, v) => (k === 'x-robots-tag' ? /noindex/.test(r.h(k) || '') && /nofollow/.test(r.h(k) || '') : r.h(k) === v);
    const bad = Object.entries(shared).filter(([k, v]) => !ok(k, v)).map(([k, v]) => `${k} is ${r.h(k) === null ? 'missing' : `"${r.h(k)}"`}, not "${v}"`);
    if (https && !r.h('strict-transport-security')) bad.push('no Strict-Transport-Security');
    if (bad.length) wrong.push(`${label}: ${bad.join('; ')}`);
  };
  // Exactly one policy, the expected one (the storage origin aside, reported below).
  const policy = (label, r, expected) => {
    const v = r.h('content-security-policy');
    if (!v) { wrong.push(`${label} sends no Content-Security-Policy`); return; }
    // Two headers arrive joined by ", " — a policy itself never contains one.
    if (v.includes(', ')) { wrong.push(`${label} sends more than one Content-Security-Policy`); return; }
    if (shape(v) !== shape(expected)) { wrong.push(`${label} policy differs from lib/csp.js: "${v}"`); return; }
    for (const o of v.match(STORAGE) || []) seenStorage.add(o);
  };
  const same = (label, r, bytes) => { if (sha(r.body) !== sha(bytes)) wrong.push(`${label} is not this checkout's build (run node scripts/build.mjs, commit, redeploy)`); };

  // 0. Can it be reached at all?
  let robots;
  try { robots = await get('/robots.txt'); } catch (e) { return { reached: false, why: `could not reach ${base}: ${e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message}` }; }
  if (robots.status === 401 || robots.status === 403) return { reached: false, why: `${base} answered ${robots.status}: ${bypass ? 'VERCEL_PROTECTION_BYPASS was refused (check the secret)' : 'a protected preview needs VERCEL_PROTECTION_BYPASS'}` };
  if (robots.status !== 200 || !/Disallow:\s*\/\s*$/m.test(robots.body.toString('utf8'))) wrong.push(`robots.txt answered ${robots.status} without "Disallow: /"`);
  else held.push('robots.txt disallows everything');

  // 1. The client page: this checkout's view, under the client policy, never cached.
  const slug = randomBytes(8).toString('hex').slice(0, 10);
  const view = local('views/proposal.html');
  const page = await get(`/p/${slug}?t=${randomBytes(32).toString('hex')}`);
  if (page.status !== 200) wrong.push(`a client link answered ${page.status}`);
  else {
    const before = wrong.length;
    same('the client page', page, view);
    policy('the client page', page, CLIENT_CSP);
    sharedHeaders('the client page', page);
    if (!/no-store/.test(page.h('cache-control') || '')) wrong.push('the client page may be cached (no Cache-Control: no-store)');
    if (wrong.length === before) held.push('a client link serves this checkout\'s page under the client policy, never cached');
  }

  // 2. Everything the page loads, and what its stylesheets load: the same bytes, the right types.
  const html = view.toString('utf8');
  const assets = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)].map((m) => m[1]));
  for (const css of [...assets].filter((p) => p.endsWith('.css'))) {
    for (const m of local(css).toString('utf8').matchAll(/url\(["']?(\/assets\/[^"')#?]+)/g)) assets.add(m[1]);
  }
  let assetsOk = 0;
  for (const path of assets) {
    const r = await get(path);
    if (r.status !== 200) { wrong.push(`${path} answered ${r.status}`); continue; }
    const before = wrong.length;
    same(path, r, local(path));
    const type = TYPES[extname(path)];
    if (type && !type.test(r.h('content-type') || '')) wrong.push(`${path} is served as ${r.h('content-type')}`);
    if (r.h('x-content-type-options') !== 'nosniff') wrong.push(`${path} lacks nosniff`);
    policy(path, r, CLIENT_CSP);
    if (wrong.length === before) assetsOk += 1;
  }
  if (assetsOk === assets.size) held.push(`all ${assets.size} files the page and its stylesheets load are this checkout's, with the right types`);

  // 3. pdf.js: its own narrower policy, cached for good, the same pinned bytes (D5, its header half).
  const pdfjs = (/const PDFJS = '([^']+)'/.exec(local('assets/js/pdf-viewer.js').toString('utf8')) || [])[1];
  const wasm = pdfjs && existsSync(resolve(ROOT, pdfjs.slice(1), 'wasm')) ? readdirSync(resolve(ROOT, pdfjs.slice(1), 'wasm')).find((f) => f.endsWith('.wasm')) : null;
  const vendorFiles = pdfjs ? ['pdf.worker.min.js', 'pdf.min.js', ...(wasm ? [`wasm/${wasm}`] : [])].map((f) => pdfjs + f) : [];
  if (!vendorFiles.length) wrong.push('could not find the pdf.js path in assets/js/pdf-viewer.js');
  let vendorOk = 0;
  for (const path of vendorFiles) {
    const r = await get(path);
    if (r.status !== 200) { wrong.push(`${path} answered ${r.status}`); continue; }
    const before = wrong.length;
    same(path, r, local(path));
    const v = r.h('content-security-policy') || '';
    if (v !== WORKER_CSP) wrong.push(`${path} is sent with ${v ? (v.includes(', ') ? 'more than one policy' : `"${v}"`) : 'no policy'}, not WORKER_CSP`);
    if (!/immutable/.test(r.h('cache-control') || '')) wrong.push(`${path} is not cached as immutable`);
    const type = TYPES[extname(path)];
    if (type && !type.test(r.h('content-type') || '')) wrong.push(`${path} is served as ${r.h('content-type')}`);
    if (wrong.length === before) vendorOk += 1;
  }
  if (vendorFiles.length && vendorOk === vendorFiles.length) held.push(`pdf.js (${pdfjs}) is the pinned copy, under its own worker policy alone, cached for good${wasm ? '; its WebAssembly is served as application/wasm' : ''}`);

  // 4. A page that does not exist: the styled 404, with its status.
  const missing = await get(`/no-such-page-${slug}`);
  {
    const before = wrong.length;
    if (missing.status !== 404) wrong.push(`a page that does not exist answered ${missing.status}, not 404`);
    else { same('the 404 page', missing, local('views/404.html')); policy('the 404 page', missing, CLIENT_CSP); sharedHeaders('the 404 page', missing); }
    if (wrong.length === before) held.push('a page that does not exist answers 404 with the styled page');
  }

  // 5. D1: nothing outside public/ is a URL.
  let leaks = 0;
  for (const path of PRIVATE) {
    const r = await get(path);
    if (r.status === 404) continue;
    leaks += 1;
    const file = resolve(ROOT, path.slice(1));
    const ours = r.status === 200 && existsSync(file) && sha(r.body) === sha(readFileSync(file));
    wrong.push(`D1: ${path} answered ${r.status}${ours ? ' with the repository\'s own file' : ''}, not 404`);
  }
  if (!leaks) held.push(`D1: none of ${PRIVATE.length} private files is served (the editor and its library, the website snapshot, the schema, the source; each answers 404)`);

  // 6. The demo: a preview may show it, scrubbed; production never.
  const demo = await get('/demo');
  if (production) {
    const shown = [];
    for (const path of DEMO_ONLY) if ((path === '/demo' ? demo : await get(path)).status !== 404) shown.push(path);
    if (shown.length) wrong.push(`production serves the demo: ${shown.join(', ')} (unset DEMO_PUBLIC)`);
    else held.push('production does not serve the demo or its fixture');
  } else if (demo.status === 200) {
    const before = wrong.length;
    same('the demo page', demo, local('views/demo.html'));
    const fx = await get('/fixtures/demo-proposal.json');
    let leaked = [];
    try { const j = JSON.parse(fx.body.toString('utf8')); leaked = ['presetsUsed', 'acks', '_about'].filter((k) => k in j); } catch { wrong.push(`the demo's fixture answered ${fx.status} and is not JSON`); }
    if (leaked.length) wrong.push(`the demo's public fixture carries editor bookkeeping: ${leaked.join(', ')}`);
    if (wrong.length === before) held.push('the preview\'s demo is this checkout\'s, and its fixture carries no editor bookkeeping');
  } else notes.push(`the demo is not served (${demo.status}); set DEMO_PUBLIC=1 on Preview to show it`);

  // 7. Staff pages: sign-in is open; the rest send a stranger to it.
  const signin = await get('/signin');
  {
    const before = wrong.length;
    if (signin.status !== 200) wrong.push(`/signin answered ${signin.status}`);
    else { same('the sign-in page', signin, Buffer.from(SIGNIN_HTML)); policy('the sign-in page', signin, CLIENT_CSP); sharedHeaders('the sign-in page', signin); }
    for (const [path, next] of [['/dashboard', '%2Fdashboard'], ['/documents', '%2Fdocuments'], ['/editor', '%2Feditor']]) {
      const r = await get(path, { manual: true });
      if (r.status !== 302 || r.h('location') !== `/signin?next=${next}`) wrong.push(`${path} without a session answered ${r.status} ${r.h('location') || ''}, not a redirect to sign in`);
    }
    if (wrong.length === before) held.push('the sign-in page is this checkout\'s; the dashboard, the Documents page and the editor send a stranger to it');
  }

  // 8. The functions are there and running, and refuse the wrong method before any database work.
  let region = '';
  {
    const before = wrong.length;
    for (const path of ['/api/accept', '/api/event', '/api/changes', '/api/attachment']) {
      const r = await get(path);
      if (r.status !== 405 || r.h('allow') !== 'POST') wrong.push(`GET ${path} answered ${r.status}, not 405 (Allow: POST)`);
      region ||= r.h('x-vercel-id') || '';
    }
    if (wrong.length === before) held.push('the client endpoints are deployed and refuse a wrong method before any database work');
    // x-vercel-id names the regions that handled the request; a function pinned to syd1 shows it.
    const regions = region.split('::').slice(0, -1);
    if (regions.length >= 2 && !regions.includes('syd1')) wrong.push(`the functions answered from ${regions.join(' → ')}, not syd1 (vercel.json "regions")`);
    else if (regions.length) notes.push(`requests were handled by ${regions.join(' → ')} (x-vercel-id)`);
  }

  // 9. With a session: the editor and dashboard, each under its own policy alone.
  if (session) {
    const cookie = `${SESSION_COOKIE}=${session}`;
    const dash = await get('/dashboard', { cookie, manual: true });
    const docs = await get('/documents', { cookie, manual: true });
    const ed = await get('/editor', { cookie, manual: true });
    if (dash.status === 302 || docs.status === 302 || ed.status === 302) notChecked.push('the editor and dashboard: the session given was not accepted (signed out, expired, or not an editor)');
    else {
      const before = wrong.length;
      for (const [label, r, bytes, expected] of [['the dashboard', dash, DASHBOARD_HTML, CLIENT_CSP], ['the Documents page', docs, LIBRARY_HTML, CLIENT_CSP], ['the editor', ed, EDITOR_HTML, EDITOR_CSP]]) {
        if (r.status !== 200) { wrong.push(`${label} answered ${r.status} with a session`); continue; }
        same(label, r, Buffer.from(bytes));
        policy(label, r, expected);
        sharedHeaders(label, r);
      }
      if (wrong.length === before) held.push('signed in, the dashboard, the Documents page and the editor are this checkout\'s, each under its own policy alone (the editor\'s adds blob: previews)');
    }
  } else notChecked.push('the editor and dashboard pages (give STAFF_SESSION, a signed-in session, to check their policies and bytes)');

  // 10. D3: the storage origin in the policies.
  const wild = [...seenStorage].filter((o) => o.includes('*'));
  const own = [...seenStorage].filter((o) => !o.includes('*'));
  if (wild.length && own.length) wrong.push(`D3: some pages allow ${wild.join(', ')} and others ${own.join(', ')}; narrow lib/csp.js and vercel.json together`);
  else if (wild.length) (production ? wrong : notes).push(`D3${production ? '' : ' open'}: storage is still allowed as ${wild[0]}; narrow it to the project's own origin in lib/csp.js and vercel.json`);
  else if (own.length) held.push(`D3: storage is allowed from ${own.join(', ')} only`);

  notChecked.push('D4 and the rest of D5 write to storage: attach, preview and download one document by hand (docs/handover.md §3)');
  return { reached: true, held, wrong, notes, notChecked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
  const url = arg('--url');
  if (!/^https?:\/\/[^/]+/.test(url || '')) { console.error('usage: node scripts/deploy-check.mjs --url https://<deployment> [--production]'); process.exit(2); }
  const production = process.argv.includes('--production');
  const r = await runDeployCheck({ url, production, bypass: process.env.VERCEL_PROTECTION_BYPASS || '', session: process.env.STAFF_SESSION || '' });
  if (!r.reached) { console.error(`NOT CHECKED  ${r.why}`); process.exit(2); }
  console.log(`${url} (${production ? 'production' : 'preview'})`);
  for (const l of r.held) console.log(`  held         ${l}`);
  for (const l of r.wrong) console.log(`  WRONG        ${l}`);
  for (const l of r.notes) console.log(`  note         ${l}`);
  for (const l of r.notChecked) console.log(`  NOT CHECKED  ${l}`);
  // D4/D5 by hand is always listed; it alone does not make a run "not checked".
  const open = r.notChecked.filter((l) => !l.startsWith('D4'));
  console.log(r.wrong.length ? '\nSomething is WRONG.' : open.length ? '\nNothing wrong, but something was NOT CHECKED.' : '\nEverything this check covers held.');
  process.exit(r.wrong.length ? 1 : open.length ? 3 : 0);
}

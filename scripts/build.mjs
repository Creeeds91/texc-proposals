#!/usr/bin/env node
/**
 * Builds the client page from its template.
 *
 *   node scripts/build.mjs
 *
 * templates/proposal.html  ->  views/proposal.html   the client page, opened through the gate (assets/js/gate.js)
 *                          ->  views/demo.html       the same page, booted from fixtures/demo-proposal.json
 *                          ->  lib/editor-html.js    the page plus the editor drawer, as a string (served behind sign-in)
 * templates/signin.html    ->  lib/signin-html.js    the staff sign-in page
 * templates/dashboard.html ->  lib/dashboard-html.js the staff dashboard (behind sign-in)
 * templates/404.html       ->  views/404.html        "this page does not exist" (public/404.html on Vercel)
 * content/, fixtures/      ->  lib/template-data.js, lib/demo-fixture.js   the server's copies
 *
 *   node scripts/build.mjs --public    also writes public/, the only static files Vercel serves
 *
 * What it fills:
 *   {{brand.<key>}}     from lib/brand.js (the only place the business is named)
 *   {{brand.json}}      the brand as a JSON data block
 *   {{template.json}}   locked lines, the website snapshot, the suite register,
 *                       the workflow and the built-in photo set, as a JSON data block
 *   {{snap.<path>}}     website wording baked in as the template's defaults
 *
 * What it refuses (the build fails, nothing is written):
 *   - any {{token}} left unfilled
 *   - an executable inline <script>, a <style> element, a style="" attribute or
 *     an on*="" handler — the client page runs under a CSP with no
 *     'unsafe-inline', so any of these would silently not run in production
 *   - editor code in a client view (Phase 2 adds the editor; the guard is here first)
 *
 * The output is deterministic: a clean `git status` after building means the
 * committed views are current.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, brandJson, fillBrand } from '../lib/brand.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

export const TEMPLATE_VERSION = 1;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dataBlock = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

export function templateData() {
  const snap = json('content/texc-snapshot.json');
  const lockedFile = json('content/locked-lines.json');
  const register = json('content/register.json');
  const workflow = json('content/workflow.json');

  const locked = {};
  for (const [key, line] of Object.entries(lockedFile)) {
    if (key.startsWith('_') || line.editorOnly) continue;
    for (const [, token] of line.text.matchAll(/\{(\w+)\}/g)) {
      if (typeof BRAND[token] !== 'string') throw new Error(`Locked line "${key}" uses {${token}}, which lib/brand.js does not define`);
    }
    locked[key] = line.text;
  }

  // Built-in photos: TEXC's own photography only, at the widths in the folder.
  const photos = {};
  for (const file of readdirSync(resolve(ROOT, 'assets/img/photos')).sort()) {
    const m = /^(.+)-(\d+)\.webp$/.exec(file);
    if (!m) continue;
    (photos[m[1]] ||= { widths: [], path: `/assets/img/photos/${m[1]}-{w}.webp` }).widths.push(Number(m[2]));
  }
  for (const p of Object.values(photos)) p.widths.sort((a, b) => a - b);

  return {
    version: TEMPLATE_VERSION,
    locked,
    snap: {
      about: snap.about,
      competency: snap.competency,
      assurance: snap.assurance,
      scopeNote: snap.scopeNote,
      workflow: { intro: workflow.intro },
    },
    services: snap.services.map(({ slug, name, category, value, overview, capabilities, integrate, safety, pending }) =>
      ({ slug, name, category, value, overview, capabilities, integrate, safety, pending })),
    serviceIcons: Object.fromEntries(snap.services.map((s) => [s.slug, s.icon])),
    people: snap.people,
    regions: snap.regions,
    register: register.documents,
    workflow: { intro: workflow.intro, stages: workflow.stages },
    photos,
    principalPhoto: photos['george-scott'] ? 'george-scott' : null,
    // CCR-03: no Risk Level Table exists, so ratings stay hidden until TEXC supplies one.
    ratingsEnabled: false,
  };
}

function snapRows(snap) {
  const strip = snap.capabilityStrip.map((c) =>
    `      <li data-row><span class="strip-label" data-col="label">${esc(c.label)}</span><span class="strip-body" data-col="body">${esc(c.body)}</span></li>`).join('\n');
  const steps = snap.about.working.steps.map((s) =>
    `      <li data-row><span class="steps4-n" data-col="number">${esc(s.number)}</span><span class="steps4-title" data-col="title">${esc(s.title)}</span><span class="steps4-body" data-col="body">${esc(s.body)}</span></li>`).join('\n');
  return { strip, steps };
}

export function checkView(name, html, { allowEditor = false } = {}) {
  const problems = [];
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scripts) {
    const isData = /type="application\/json"/i.test(tag);
    const hasSrc = /\bsrc="/i.test(tag);
    if (!isData && !hasSrc) problems.push(`inline executable script: ${tag}`);
  }
  if (/<style\b/i.test(html)) problems.push('a <style> element');
  if (/\sstyle\s*=\s*["']/i.test(html)) problems.push('a style="" attribute');
  const handler = html.match(/\son[a-z]+\s*=\s*["']/i);
  if (handler) problems.push(`an inline event handler (${handler[0].trim()})`);
  const left = html.match(/\{\{[^}]+\}\}/);
  if (left) problems.push(`an unfilled token ${left[0]}`);
  if (!allowEditor) {
    for (const leak of ['/assets/js/editor', '/assets/css/editor.css', 'passphrase.js', 'id="library-data"']) {
      if (html.includes(leak)) problems.push(`editor code in a client view (${leak})`);
    }
  }
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
}

export function build({ write = true } = {}) {
  const snap = json('content/texc-snapshot.json');
  const rows = snapRows(snap);
  const data = templateData();
  let html = read('templates/proposal.html');

  html = html
    .replace('{{brand.json}}', brandJson())
    .replace('{{template.json}}', dataBlock(data))
    .replace('{{snap.strip.rows}}', rows.strip)
    .replace('{{snap.steps.rows}}', rows.steps)
    .replace(/\{\{snap\.([a-zA-Z.]+)\}\}/g, (m, path) => {
      const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), snap);
      if (typeof v !== 'string') throw new Error(`Unknown snapshot token ${m}`);
      return esc(v);
    });
  html = fillBrand(html);

  const views = {
    // The client page opens through the gate (assets/js/gate.js): nothing shows until it decrypts.
    'views/proposal.html': html
      .replace('data-tpl="1"', `data-tpl="${TEMPLATE_VERSION}" data-boot="gate"`)
      .replace('<script type="module" src="/assets/js/proposal.js"></script>', '<script type="module" src="/assets/js/proposal.js"></script>\n<script type="module" src="/assets/js/gate.js"></script>'),
    // The demo's banner is there from the first paint, so it never pushes the page down as it loads.
    'views/demo.html': html.replace('data-tpl="1"', `data-tpl="${TEMPLATE_VERSION}" data-boot="fixture" data-fixture="/fixtures/demo-proposal.json"`)
      .replace('<div id="demo-chip" class="demo-chip" hidden>', '<div id="demo-chip" class="demo-chip">'),
  };
  // Not found: what any address that is not a page answers, in the proposal's own design.
  views['views/404.html'] = fillBrand(read('templates/404.html'));
  for (const [name, body] of Object.entries(views)) checkView(name, body);

  // The editor: the same page with the drawer added. It is NOT a static file —
  // it is a string module served behind sign-in (Phase 3: api/editor.js; until
  // then only the local server serves it), so it is never public on Vercel.
  const library = json('content/library.seed.json');
  const editorHtml = html
    .replace('data-mode="published"', 'data-mode="editor"')
    .replace('data-tpl="1"', `data-tpl="${TEMPLATE_VERSION}" data-boot="editor"`)
    .replace(/(<title[^>]*>)[^<]*(<\/title>)/, `$1Proposal editor · ${esc(BRAND.name)}$2`)
    .replace('<link rel="stylesheet" href="/assets/css/print.css" media="print">', '<link rel="stylesheet" href="/assets/css/print.css" media="print">\n<link rel="stylesheet" href="/assets/css/editor.css">')
    .replace('<script type="module" src="/assets/js/proposal.js"></script>', `<script type="application/json" id="library-data">${dataBlock(library)}</script>\n<script type="module" src="/assets/js/proposal.js"></script>\n<script type="module" src="/assets/js/editor/main.js"></script>`);
  checkView('editor', editorHtml, { allowEditor: true });
  if (!editorHtml.includes('/assets/js/editor/main.js') || !editorHtml.includes('data-boot="editor"')) throw new Error('editor: the drawer was not added to the page');
  const editorModule = `// Generated by scripts/build.mjs from templates/proposal.html — never edit.\n// Served only behind sign-in (Phase 3) or by the local server.\nexport const EDITOR_HTML = ${JSON.stringify(editorHtml)};\n`;

  // The server's copy of the template data: endpoints import this module rather
  // than reading content/ at run time, so a deployment carries exactly what it
  // was built with (and content/ is never deployed).
  const snapshot = json('content/texc-snapshot.json');
  const dataModule = '// Generated by scripts/build.mjs from content/ — never edit.\n'
    + `export const TEMPLATE_VERSION = ${TEMPLATE_VERSION};\n`
    + `const DATA = ${JSON.stringify(data)};\n`
    + `export const SNAP_ROWS = ${JSON.stringify({ strip: snapshot.capabilityStrip, steps: snapshot.about.working.steps })};\n`
    + 'export function templateData() { return DATA; }\n';

  // The staff sign-in page: public, holds nothing, same strict CSP as the client page.
  const signinHtml = fillBrand(read('templates/signin.html'));
  checkView('signin', signinHtml);
  const signinModule = `// Generated by scripts/build.mjs from templates/signin.html — never edit.\nexport const SIGNIN_HTML = ${JSON.stringify(signinHtml)};\n`;

  // The dashboard: like the editor, a string served behind sign-in (api/dashboard.js), never a public file.
  const dashboardHtml = fillBrand(read('templates/dashboard.html'));
  checkView('dashboard', dashboardHtml);
  const dashboardModule = `// Generated by scripts/build.mjs from templates/dashboard.html — never edit.\nexport const DASHBOARD_HTML = ${JSON.stringify(dashboardHtml)};\n`;

  // The demo proposal, for the editor's "Load the demo" (served behind sign-in).
  const fixtureModule = `// Generated by scripts/build.mjs from fixtures/demo-proposal.json — never edit.\nexport const DEMO_FIXTURE = ${JSON.stringify(json('fixtures/demo-proposal.json'))};\n`;

  const outputs = {
    ...views, 'lib/editor-html.js': editorModule, 'lib/template-data.js': dataModule,
    'lib/signin-html.js': signinModule, 'lib/dashboard-html.js': dashboardModule, 'lib/demo-fixture.js': fixtureModule,
  };
  if (write) {
    mkdirSync(resolve(ROOT, 'views'), { recursive: true });
    for (const [name, body] of Object.entries(outputs)) writeFileSync(resolve(ROOT, name), body);
  }
  return outputs;
}

/**
 * What Vercel serves as static files: an explicit list, copied into public/
 * (vercel.json outputDirectory). Everything else in the repo — lib/, content/,
 * templates/, scripts/ — is never a URL (open item D1). The demo page and its
 * fictional fixture are included only when DEMO_PUBLIC=1 (preview deployments).
 */
export function writePublic({ demo = process.env.DEMO_PUBLIC === '1' } = {}) {
  const out = resolve(ROOT, 'public');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(resolve(out, 'views'), { recursive: true });
  cpSync(resolve(ROOT, 'assets'), resolve(out, 'assets'), { recursive: true });
  cpSync(resolve(ROOT, 'views/proposal.html'), resolve(out, 'views/proposal.html'));
  cpSync(resolve(ROOT, 'views/404.html'), resolve(out, '404.html'));
  cpSync(resolve(ROOT, 'robots.txt'), resolve(out, 'robots.txt'));
  if (demo) {
    cpSync(resolve(ROOT, 'views/demo.html'), resolve(out, 'views/demo.html'));
    // The public copy of the demo carries nothing but what its page shows:
    // no editor bookkeeping (whose notes name the real job it was drawn from).
    const fixture = json('fixtures/demo-proposal.json');
    for (const k of ['presetsUsed', 'acks', '_about']) delete fixture[k];
    mkdirSync(resolve(out, 'fixtures'), { recursive: true });
    writeFileSync(resolve(out, 'fixtures/demo-proposal.json'), JSON.stringify(fixture));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const views = build();
    for (const [name, body] of Object.entries(views)) console.log(`wrote ${name} (${Buffer.byteLength(body)} bytes)`);
    if (process.argv.includes('--public')) console.log(`wrote ${writePublic()}`);
  } catch (err) {
    console.error('BUILD FAILED —', err.message);
    process.exit(1);
  }
}

#!/usr/bin/env node
/**
 * Copies the approved website wording this system reuses out of the website's
 * own content files, so a proposal never carries a retyped (and drifting)
 * version of a compliance line.
 *
 *   node scripts/texc-content-sync.mjs            write content/texc-snapshot.json
 *   node scripts/texc-content-sync.mjs --check    fail if the committed snapshot is stale
 *   ... --site <path>                             website checkout (default ../texc)
 *
 * The website lives in its own repo. This reads a sibling checkout of it:
 *
 *   git clone https://github.com/Creeeds91/texc ../texc
 *
 * Exit codes: 0 ok · 1 stale or broken · 3 NOT CHECKED (no sibling checkout).
 * A skip is "not checked", never "fine" — the Roberts convention.
 *
 * The content files are TypeScript. Node strips the types itself (22.6+); the
 * one thing it will not do is resolve `import { siteConfig } from "./site"`
 * without an extension, so a six-line resolve hook adds `.ts` (needs 22.15+).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import module from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'content/texc-snapshot.json');
const args = process.argv.slice(2);
const check = args.includes('--check');
const siteArg = args.indexOf('--site');
const SITE = resolve(ROOT, siteArg >= 0 ? args[siteArg + 1] : '../texc');

if (!existsSync(resolve(SITE, 'content/services.ts'))) {
  console.log(`NOT CHECKED — no website checkout at ${SITE}`);
  console.log('Clone it beside this repo: git clone https://github.com/Creeeds91/texc ../texc');
  process.exit(3);
}

if (typeof module.registerHooks !== 'function') {
  console.error('Node 22.15 or later is needed (module.registerHooks).');
  process.exit(1);
}
module.registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
      throw err;
    }
  },
});

const load = (f) => import(pathToFileURL(resolve(SITE, 'content', f)).href);
const [{ siteConfig, capabilityStrip }, { services }, pages] = await Promise.all([
  load('site.ts'), load('services.ts'), load('pages.ts'),
]);

const sha = (() => {
  try {
    const head = readFileSync(resolve(SITE, '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = resolve(SITE, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = readFileSync(resolve(SITE, '.git/packed-refs'), 'utf8');
    return (packed.split('\n').find((l) => l.endsWith(' ' + ref)) || '').split(' ')[0] || 'unknown';
  } catch { return 'unknown'; }
})();

// Only what the proposal uses, field by field. Anything not listed here is
// deliberately not carried — notably the stock imagery and the pending
// services' marketing copy.
const snapshot = {
  source: { repo: 'Creeeds91/texc', commit: sha, files: ['content/site.ts', 'content/services.ts', 'content/pages.ts'] },
  site: {
    legalName: siteConfig.legalName,
    tagline: siteConfig.tagline,
    positioning: siteConfig.positioning,
    principal: siteConfig.principal,
  },
  capabilityStrip,
  services: services.map((s) => ({
    slug: s.slug, name: s.name, category: s.category, icon: s.icon, value: s.value,
    overview: s.overview, capabilities: s.capabilities, integrate: s.integrate, safety: s.safety,
    pending: Boolean(s.pending),
  })),
  about: {
    support: { eyebrow: pages.about.support.eyebrow, heading: pages.about.support.heading, body: pages.about.support.body, quote: pages.about.support.quote },
    working: { eyebrow: pages.about.working.eyebrow, heading: pages.about.working.heading, steps: pages.about.working.steps },
  },
  scopeNote: pages.servicesPage.scopeNote,
  competency: { heading: pages.capability.competency.heading, body: pages.capability.competency.body },
  assurance: pages.safety.assurance,
  emergency: pages.contact.emergency,
  regions: pages.request.regions,
  people: pages.team.people.map((p) => ({
    slug: p.slug, name: p.name, role: p.role, bio: p.bio,
    competencies: p.competencies, licences: p.licences, licenceNote: p.licenceNote,
  })),
};

const text = JSON.stringify(snapshot, null, 2) + '\n';

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // The commit line moves on every website commit; only the words matter.
  const strip = (t) => t.replace(/"commit": "[^"]*"/, '"commit": ""');
  if (strip(current) !== strip(text)) {
    console.error('STALE — content/texc-snapshot.json no longer matches the website copy.');
    console.error('Run: node scripts/texc-content-sync.mjs   then review the diff before committing.');
    process.exit(1);
  }
  console.log(`ok — snapshot matches the website copy (texc @ ${sha.slice(0, 7)})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote content/texc-snapshot.json from texc @ ${sha.slice(0, 7)}`);
}

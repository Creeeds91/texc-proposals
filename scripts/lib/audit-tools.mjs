/**
 * Finds the audit tools — axe-core (accessibility rules) and Lighthouse —
 * without making them dependencies of this repo, as browser.mjs finds
 * Playwright. Order: a local install, $AUDIT_TOOLS_DIR,
 * ~/.cache/texc-audit-tools, /opt/node-tools. Install them once with:
 *
 *   npm install --prefix ~/.cache/texc-audit-tools axe-core@4.13.0 lighthouse@13.4.1
 *
 * When one is missing the suites that need it report NOT CHECKED (exit 3),
 * never passed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = [join(ROOT, 'node_modules'), process.env.AUDIT_TOOLS_DIR && join(process.env.AUDIT_TOOLS_DIR, 'node_modules'),
  join(homedir(), '.cache/texc-audit-tools/node_modules'), '/opt/node-tools/node_modules'].filter(Boolean);

const find = (rel) => DIRS.map((d) => join(d, rel)).find((p) => existsSync(p)) || null;

/** The axe-core script, to inject into a page, or null. */
export function axeSource() {
  const p = find('axe-core/axe.min.js');
  return p ? readFileSync(p, 'utf8') : null;
}

export const axeVersion = () => { const p = find('axe-core/package.json'); return p ? JSON.parse(readFileSync(p, 'utf8')).version : null; };

/** The Lighthouse command line, or null. */
export const lighthouseCli = () => find('lighthouse/cli/index.js');
export const lighthouseVersion = () => { const p = find('lighthouse/package.json'); return p ? JSON.parse(readFileSync(p, 'utf8')).version : null; };

/** The Chromium Playwright ships, for Lighthouse to drive. */
export function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = join(base, d, 'chrome-linux/chrome');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Finds Playwright without making it a dependency of this repo. Order: a local
 * install, then the global one the cloud container ships, then $PLAYWRIGHT_DIR.
 * Exit code 2 from a caller means "could not run" — never "passed".
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed locally */ }
  const dirs = [process.env.PLAYWRIGHT_DIR, '/opt/node-tools/node_modules', '/usr/local/lib/node_modules', '/opt/node22/lib/node_modules'].filter(Boolean);
  for (const dir of dirs) {
    if (!existsSync(`${dir}/playwright`)) continue;
    return createRequire(`${dir}/`)('playwright');
  }
  return null;
}

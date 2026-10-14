#!/usr/bin/env node
/**
 * Serves the client page and the demo locally the way Vercel will: the same
 * rewrites, and the SAME headers, read from vercel.json — so the CSP is
 * exercised on every local run, not discovered in production. No database:
 * for the editor, sign-in and publishing, use scripts/demo/local-app.mjs.
 *
 *   node scripts/demo/serve.mjs [--port 4310]
 *   then open http://127.0.0.1:4310/demo
 *
 * Text is compressed as Vercel compresses it (Brotli, else gzip, when the
 * browser asks), so byte budgets and Lighthouse measure what a phone would
 * download. Exported as startServer() for the capture and check scripts.
 */
import { createServer } from 'node:http';
import { brotliCompressSync, gzipSync, constants as Z } from 'node:zlib';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf',
};
// Only what a deployment would serve. Source folders stay private.
const PUBLIC = ['assets/', 'views/', 'fixtures/', 'robots.txt'];

function vercelRules() {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
  const toRe = (src) => new RegExp('^' + src.replace(/:(\w+)/g, '([^/]+)') + '$');
  return {
    rewrites: (cfg.rewrites || []).map((r) => ({ re: toRe(r.source), to: r.destination })),
    headers: (cfg.headers || []).map((h) => ({ re: new RegExp('^' + h.source + '$'), headers: h.headers })),
  };
}

export function startServer({ port = 4310, overrides = {} } = {}) {
  const rules = vercelRules();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    let path = decodeURIComponent(url.pathname);
    for (const h of rules.headers) if (h.re.test(path)) for (const { key, value } of h.headers) res.setHeader(key, overrides[key] ?? value);
    if (path === '/') path = '/demo';
    for (const r of rules.rewrites) if (r.re.test(path)) { path = r.to; break; }
    const rel = normalize(path).replace(/^[/\\]+/, '');
    const file = resolve(ROOT, rel);
    const allowed = PUBLIC.some((p) => rel === p || rel.startsWith(p));
    if (!allowed || !file.startsWith(ROOT + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      // As Vercel does: the static 404 page, with a 404 status.
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(resolve(ROOT, 'views/404.html')));
      return;
    }
    const type = TYPES[extname(file)] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    let bytes = readFileSync(file);
    const accepts = String(req.headers['accept-encoding'] || '');
    if (/^(text\/|application\/json|image\/svg)/.test(type) && bytes.length > 1024) {
      if (/\bbr\b/.test(accepts)) { bytes = brotliCompressSync(bytes, { params: { [Z.BROTLI_PARAM_QUALITY]: 5 } }); res.setHeader('Content-Encoding', 'br'); }
      else if (/\bgzip\b/.test(accepts)) { bytes = gzipSync(bytes); res.setHeader('Content-Encoding', 'gzip'); }
      res.setHeader('Vary', 'Accept-Encoding');
    }
    res.end(bytes);
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4310;
  startServer({ port }).then(() => console.log(`http://127.0.0.1:${port}/demo  (headers from vercel.json; the editor needs local-app.mjs)`));
}

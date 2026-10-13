#!/usr/bin/env node
/**
 * The whole app on this machine: the real api/* handlers, routed by
 * vercel.json's own rewrites and headers, in front of a real Postgres and the
 * real PostgREST (scripts/lib/local-supabase.mjs). No network, no production
 * data, and every run starts from an empty database unless --keep is given.
 *
 *   node scripts/demo/local-app.mjs [--port 4400] [--keep]
 *
 * Sign in as studio@example.com (a super) — the code is in the outbox:
 *   GET /__dev/outbox    the emails "sent", newest last (local only)
 *
 * Exported as startLocalApp() for the check suites and captures.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, normalize, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { startLocalSupabase } from '../lib/local-supabase.mjs';
import { build, writePublic } from '../build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
};
export const SUPER_EMAIL = 'studio@example.com';
// A second Brand in Black test account, so API-level checks do not spend the
// first one's sign-in codes (three per address per ten minutes, as in production).
export const CHECK_EMAIL = 'checks@example.com';

function vercelRules() {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
  return {
    rewrites: (cfg.rewrites || []).map((r) => {
      const names = [];
      const re = new RegExp('^' + r.source.replace(/:(\w+)/g, (m, n) => { names.push(n); return '([^/]+)'; }) + '$');
      return { re, names, to: r.destination };
    }),
    headers: (cfg.headers || []).map((h) => ({ re: new RegExp('^' + h.source + '$'), headers: h.headers })),
  };
}

const readAll = (req) => new Promise((done) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => done(Buffer.concat(c))); });

/** Vercel's Node helpers, enough for api/*: req.query, req.body, res.status/json/send. */
function vercelify(req, res, query, raw) {
  req.query = query;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!raw.length) req.body = undefined;
  else if (type === 'application/json') { try { req.body = JSON.parse(raw.toString('utf8')); } catch { req.body = raw.toString('utf8'); } }
  else if (type.startsWith('text/')) req.body = raw.toString('utf8');
  else req.body = raw;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  res.send = (b) => { if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return res.json(b); res.end(b); return res; };
}

export async function startLocalApp({ port = 4400, keep = false, dir } = {}) {
  build();
  const pub = writePublic({ demo: true });
  const home = dir || join(tmpdir(), 'texc-local-app' + (keep ? '' : '-' + randomBytes(3).toString('hex')));
  const sb = await startLocalSupabase({ dir: home });
  if (!sb) return null;
  const outbox = join(home, 'outbox.jsonl');
  mkdirSync(home, { recursive: true });
  writeFileSync(outbox, '');
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    SUPABASE_URL: sb.url, SUPABASE_SECRET_KEY: sb.secretKey,
    VAULT_KEY: process.env.LOCAL_VAULT_KEY || randomBytes(32).toString('base64'),
    IP_HASH_KEY: randomBytes(16).toString('hex'), PUBLIC_BASE_URL: base,
    ACCOUNT_SUPERS: `${SUPER_EMAIL},${CHECK_EMAIL}`, ACCOUNT_DOMAINS: 'example.com', MAIL_OUTBOX: outbox, NOTIFY_TO: 'office@example.com',
  });
  const rules = vercelRules();
  const handlers = new Map();
  const handlerFor = async (name) => {
    if (!handlers.has(name)) {
      const file = resolve(ROOT, 'api', `${name}.js`);
      if (!existsSync(file)) return null;
      handlers.set(name, (await import(pathToFileURL(file).href)).default);
    }
    return handlers.get(name);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      let path = decodeURIComponent(url.pathname);
      for (const h of rules.headers) if (h.re.test(path)) for (const { key, value } of h.headers) {
        // Locally, signed photograph and document links come from the stand-in storage host, not *.supabase.co.
        res.setHeader(key, key === 'Content-Security-Policy' ? value.replaceAll('https://*.supabase.co', sb.url) : value);
      }
      if (path === '/__dev/outbox') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(readFileSync(outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
        return;
      }
      if (path === '/') path = '/demo';
      const query = Object.fromEntries(url.searchParams);
      for (const r of rules.rewrites) {
        const m = r.re.exec(path);
        if (!m) continue;
        let dest = r.to;
        r.names.forEach((n, i) => { dest = dest.replace(`:${n}`, encodeURIComponent(m[i + 1])); });
        const d = new URL(dest, base);
        path = d.pathname;
        for (const [k, v] of d.searchParams) query[k] = v;
        break;
      }
      if (path.startsWith('/api/')) {
        const handler = await handlerFor(path.slice(5).replace(/\/$/, ''));
        if (!handler) { res.statusCode = 404; res.end('Not found'); return; }
        // Pages served by functions set their own CSP; locally, photographs come from the stand-in storage host.
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (k, v) => setHeader(k, String(k).toLowerCase() === 'content-security-policy' ? String(v).replaceAll('https://*.supabase.co', sb.url) : v);
        vercelify(req, res, query, await readAll(req));
        await handler(req, res);
        // The real handlers set their own CSP on pages; the static header above covers the rest.
        if (!res.writableEnded) res.end();
        return;
      }
      const rel = normalize(path).replace(/^[/\\]+/, '');
      const file = resolve(pub, rel);
      if (!file.startsWith(pub + sep) || !existsSync(file) || statSync(file).isDirectory()) { res.statusCode = 404; res.end('Not found'); return; }
      res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
      res.end(readFileSync(file));
    } catch (e) {
      if (!res.headersSent) res.statusCode = 500;
      res.end('Server error: ' + e.message);
    }
  });
  await new Promise((d) => server.listen(port, '127.0.0.1', d));
  const mail = () => readFileSync(outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stop = () => { server.close(); if (keep) sb.stop(); else sb.destroy(); };
  return { url: base, sb, outbox: mail, stop };
}

/** The newest sign-in code emailed to an address (from the local outbox). */
export function codeFor(mails, email) {
  for (let i = mails.length - 1; i >= 0; i -= 1) {
    const m = mails[i];
    if (m.to.includes(email) && /sign-in code: (\d{6})/.test(m.subject)) return /sign-in code: (\d{6})/.exec(m.subject)[1];
  }
  return '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4400;
  const app = await startLocalApp({ port, keep: process.argv.includes('--keep') });
  if (!app) { console.error('NOT RUN — Postgres 16 or Docker is not available here'); process.exit(2); }
  console.log(`${app.url}/signin   sign in as ${SUPER_EMAIL}; codes at ${app.url}/__dev/outbox`);
  const bye = () => { app.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

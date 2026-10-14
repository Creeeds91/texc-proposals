/**
 * A Supabase-shaped stack on this machine, from nothing, with no network
 * beyond the first image pull and no production data:
 *
 *   Postgres 16   a scratch cluster, with Supabase's roles (anon, authenticated,
 *                 service_role, authenticator) and Supabase's default grants, so
 *                 supabase/schema.sql is tested in the shape it really runs in
 *   PostgREST     the real server Supabase puts in front of Postgres (Docker)
 *   gateway       a small Node front door that behaves like Supabase's for the
 *                 parts this app uses: the new `sb_secret_` key goes in the
 *                 `apikey` header ONLY (a key sent as `Authorization: Bearer`
 *                 is refused, as the platform refuses it), /rest/v1 proxies to
 *                 PostgREST, and /storage/v1 is a file-backed stand-in for the
 *                 storage calls lib/storage.js makes
 *
 *   const sb = await startLocalSupabase({ dir });   // { url, secretKey, anonKey, conn, stop }
 *
 * Used by scripts/schema-standup-check.mjs, scripts/demo/local-app.mjs and the
 * Phase 3 check suites. Returns null when Postgres or Docker is not available,
 * so callers can report NOT CHECKED rather than pass.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const POSTGREST_IMAGE = 'postgrest/postgrest:v12.2.3';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
export function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

function asPostgres(cmd, args, opts = {}) {
  // initdb and the server refuse to run as root; the package ships a postgres user.
  const runAs = process.getuid && process.getuid() === 0 ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  return spawnSync(runAs[0], runAs[1], { encoding: 'utf8', ...opts });
}

export function available() {
  const pg = existsSync(join(PG_BIN, 'postgres'));
  const docker = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
  return { pg, docker };
}

function ensureDocker() {
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0) return true;
  if (!existsSync('/usr/bin/dockerd')) return false;
  spawnSync('sh', ['-c', 'nohup dockerd >/tmp/dockerd.log 2>&1 &']);
  // A cold container can take well over 20 seconds to bring the daemon up.
  for (let i = 0; i < 180; i += 1) {
    if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0) return true;
    spawnSync('sleep', ['0.5']);
  }
  return false;
}

const freePort = () => new Promise((done) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

/** Run SQL as the postgres superuser on the scratch cluster. */
export function psql(conn, sql, { file = false } = {}) {
  const args = [conn, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-tA', file ? '-f' : '-c', sql];
  return execFileSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Supabase's roles and default privileges, as a fresh Supabase project has them
// before any of our SQL runs: anon and authenticated are GRANTED everything new
// in public by default, so the schema's own revokes are what lock it down.
const SUPABASE_BOOTSTRAP = `
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role authenticator login noinherit password 'authenticator'; exception when duplicate_object then null; end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/**
 * Start (or reuse) the stack. `dir` holds the cluster and stored files; pass a
 * fresh directory for an empty database. `schema: true` applies supabase/schema.sql.
 */
export async function startLocalSupabase({ dir, schema = true, quiet = true } = {}) {
  const have = available();
  if (!have.pg) return null;
  if (!ensureDocker()) return null;
  mkdirSync(dir, { recursive: true });
  // The server runs as the postgres user, which cannot reach most working
  // folders, so its cluster lives in a folder of its own under the system tmp.
  const pgRoot = join(tmpdir(), 'texc-pg-' + createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12));
  mkdirSync(pgRoot, { recursive: true });
  if (process.getuid && process.getuid() === 0) spawnSync('chown', ['-R', 'postgres:postgres', pgRoot]);
  const pgdata = join(pgRoot, 'pgdata');
  const sock = pgRoot;
  const pgPort = await freePort();
  if (!existsSync(join(pgdata, 'PG_VERSION'))) {
    const r = asPostgres(join(PG_BIN, 'initdb'), ['-D', pgdata, '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb failed: ' + r.stderr);
  }
  const logFile = join(pgRoot, 'postgres.log');
  const start = asPostgres(join(PG_BIN, 'pg_ctl'), ['-D', pgdata, '-l', logFile, '-w', '-o', `-p ${pgPort} -k ${sock} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);
  if (start.status !== 0) throw new Error('postgres did not start: ' + start.stderr + readFileSync(logFile, 'utf8').slice(-800));
  const conn = `postgresql://postgres@127.0.0.1:${pgPort}/postgres`;
  psql(conn, SUPABASE_BOOTSTRAP);
  if (schema) psql(conn, resolve(ROOT, 'supabase/schema.sql'), { file: true });

  // PostgREST, the real one.
  const jwtSecret = randomBytes(32).toString('hex');
  const restPort = await freePort();
  const name = `texc-postgrest-${restPort}`;
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host',
    '-e', `PGRST_DB_URI=postgres://authenticator:authenticator@127.0.0.1:${pgPort}/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${jwtSecret}`, '-e', `PGRST_SERVER_PORT=${restPort}`, '-e', 'PGRST_SERVER_HOST=127.0.0.1',
    '-e', 'PGRST_DB_POOL=5', POSTGREST_IMAGE], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error('PostgREST did not start: ' + run.stderr);
  for (let i = 0; i < 60; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${restPort}/`).then((r) => r.status < 500).catch(() => false);
    if (ok) break;
    await new Promise((d) => setTimeout(d, 250));
  }

  // The keys, as a project's API settings show them.
  const secretKey = 'sb_secret_' + b64url(randomBytes(24));
  const anonKey = 'sb_publishable_' + b64url(randomBytes(24));
  const roleJwt = (role) => signJwt({ role, iss: 'local', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 30 }, jwtSecret);
  const serviceJwt = roleJwt('service_role');
  const anonJwt = roleJwt('anon');

  const store = join(dir, 'storage');
  mkdirSync(store, { recursive: true });
  const gateway = createServer((req, res) => gatewayHandle(req, res, { restPort, secretKey, anonKey, serviceJwt, anonJwt, store, jwtSecret, quiet }));
  const gwPort = await freePort();
  await new Promise((d) => gateway.listen(gwPort, '127.0.0.1', d));

  const stop = () => {
    gateway.close();
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
    asPostgres(join(PG_BIN, 'pg_ctl'), ['-D', pgdata, '-m', 'immediate', 'stop']);
  };
  /** Stop, and delete the cluster and stored files: the next start is an empty database. */
  const destroy = () => { stop(); rmSync(pgRoot, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); };
  return { url: `http://127.0.0.1:${gwPort}`, secretKey, anonKey, conn, stop, destroy, dir };
}

/* ------------------------------------------------------------ the gateway */

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

function readAll(req) {
  return new Promise((done) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => done(Buffer.concat(chunks))); });
}

async function gatewayHandle(req, res, ctx) {
  const url = new URL(req.url, 'http://gw');
  const apikey = String(req.headers.apikey || '');
  const auth = String(req.headers.authorization || '');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  // Signed storage URLs need no key: the token in the URL is the authority.
  // Browsers reach these directly, so they answer CORS as the platform does.
  if (url.pathname.startsWith('/storage/v1/object/') && req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, PUT, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-upsert, cache-control, authorization, apikey', 'access-control-max-age': '600' });
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/storage/v1/object/sign/')) return storageSignedGet(url, res, ctx);
  if (req.method === 'PUT' && url.pathname.startsWith('/storage/v1/object/upload/sign/')) return storageSignedPut(req, url, res, ctx);

  // The platform refuses an opaque key presented as a bearer token ("Invalid JWT").
  if (/^Bearer\s+sb_/i.test(auth)) return send(401, { message: 'Invalid JWT' });
  let role = null;
  if (same(apikey, ctx.secretKey)) role = 'service_role';
  else if (same(apikey, ctx.anonKey)) role = 'anon';
  if (!role) return send(401, { message: 'Invalid API key' });
  const jwt = role === 'service_role' ? ctx.serviceJwt : ctx.anonJwt;

  if (url.pathname.startsWith('/rest/v1/')) {
    const body = await readAll(req);
    const headers = { ...req.headers, authorization: `Bearer ${jwt}`, host: `127.0.0.1:${ctx.restPort}` };
    delete headers.apikey;
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);
    const up = httpRequest({ host: '127.0.0.1', port: ctx.restPort, method: req.method, path: url.pathname.replace('/rest/v1', '') + url.search, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => send(502, { message: e.message }));
    up.end(body);
    return;
  }
  if (url.pathname.startsWith('/storage/v1/')) {
    if (role !== 'service_role') return send(403, { message: 'Unauthorized' });
    return storageHandle(req, res, url, ctx);
  }
  return send(404, { message: 'no route' });
}

/*
 * Storage, for exactly the calls lib/storage.js makes (Supabase Storage API):
 *   POST /storage/v1/object/<bucket>/<path>      upload (x-upsert: false → 400 if it exists)
 *   POST /storage/v1/object/sign/<bucket>        { expiresIn, paths } → [{ path, signedURL, error }]
 *   POST /storage/v1/object/sign/<bucket>/<path> { expiresIn } → { signedURL }
 *   GET  /storage/v1/object/sign/<bucket>/<path>?token=…[&download=name]   the bytes, if the token is valid
 *   POST /storage/v1/object/upload/sign/<bucket>/<path>   → { url, token }: a two-hour upload URL
 *   PUT  /storage/v1/object/upload/sign/<bucket>/<path>?token=…   the browser's upload, no key
 *   GET  /storage/v1/object/authenticated/<bucket>/<path>   the bytes, with the secret key
 *   DELETE /storage/v1/object/<bucket>           { prefixes }
 *   POST /storage/v1/object/list/<bucket>        { prefix, limit, offset } → one level: files, and folders with id null
 * Buckets are private: there is no unsigned read. Each bucket's size and type
 * limits are enforced as supabase/schema.sql sets them.
 */
const BUCKETS = new Map([
  ['texc-media', { max: 3 * 1024 * 1024, types: ['image/webp', 'image/jpeg'] }],
  ['texc-attachments', { max: 25 * 1024 * 1024, types: ['application/pdf'] }],
  ['texc-acceptances', { max: 1024 * 1024, types: ['image/png', 'text/html'] }],
]);
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-type, content-disposition' };
const safePath = (p) => p && !p.split('/').some((seg) => seg === '..' || seg === '') && /^[\w./-]+$/.test(p);

/** Store one object, as the platform would: limits first, never over an existing one. */
async function storePut(req, ctx, bucket, path, send) {
  const limits = BUCKETS.get(bucket);
  if (!safePath(path)) return send(400, { message: 'Invalid key' });
  const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  if (!limits.types.includes(type)) return send(400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
  const file = join(ctx.store, bucket, path);
  const upsert = String(req.headers['x-upsert'] || 'false') === 'true';
  if (existsSync(file) && !upsert) return send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
  const body = await readAll(req);
  if (body.length > limits.max) return send(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  writeFileSync(file + '.type', type);
  return send(200, { Key: `${bucket}/${path}` });
}

async function storageHandle(req, res, url, ctx) {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const parts = url.pathname.replace('/storage/v1/object/', '').split('/').map(decodeURIComponent);
  if (req.method === 'POST' && parts[0] === 'upload' && parts[1] === 'sign') {
    const bucket = parts[2];
    const path = parts.slice(3).join('/');
    if (!BUCKETS.has(bucket)) return send(400, { message: 'Bucket not found' });
    if (!safePath(path)) return send(400, { message: 'Invalid key' });
    const token = signJwt({ url: `${bucket}/${path}`, upload: true, exp: Math.floor(Date.now() / 1000) + 7200 }, ctx.jwtSecret);
    return send(200, { url: `/object/upload/sign/${bucket}/${path}?token=${token}`, token });
  }
  if (req.method === 'POST' && parts[0] === 'sign' && parts.length > 2) {
    const bucket = parts[1];
    const path = parts.slice(2).join('/');
    const body = JSON.parse((await readAll(req)).toString() || '{}');
    if (!BUCKETS.has(bucket)) return send(400, { message: 'Bucket not found' });
    if (!safePath(path) || !existsSync(join(ctx.store, bucket, path))) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    const token = signJwt({ url: `${bucket}/${path}`, exp: Math.floor(Date.now() / 1000) + Number(body.expiresIn || 60) }, ctx.jwtSecret);
    return send(200, { signedURL: `/object/sign/${bucket}/${path}?token=${token}` });
  }
  if (req.method === 'POST' && parts[0] === 'sign') {
    const bucket = parts[1];
    const body = JSON.parse((await readAll(req)).toString() || '{}');
    if (!BUCKETS.has(bucket)) return send(400, { message: 'Bucket not found' });
    const exp = Math.floor(Date.now() / 1000) + Number(body.expiresIn || 60);
    return send(200, (body.paths || []).map((path) => {
      const file = join(ctx.store, bucket, path);
      if (!safePath(path) || !existsSync(file)) return { path, signedURL: null, error: 'Object not found' };
      const token = signJwt({ url: `${bucket}/${path}`, exp }, ctx.jwtSecret);
      return { path, signedURL: `/object/sign/${bucket}/${path}?token=${token}`, error: null };
    }));
  }
  if (req.method === 'GET' && parts[0] === 'authenticated') {
    const bucket = parts[1];
    const path = parts.slice(2).join('/');
    const file = join(ctx.store, bucket || '', path);
    if (!BUCKETS.has(bucket) || !safePath(path) || !existsSync(file)) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    res.writeHead(200, { 'content-type': readFileSync(file + '.type', 'utf8') });
    res.end(readFileSync(file));
    return;
  }
  if (req.method === 'POST' && parts[0] === 'list') {
    const bucket = parts[1];
    const body = JSON.parse((await readAll(req)).toString() || '{}');
    const prefix = String(body.prefix || '').replace(/\/+$/, '');
    if (!BUCKETS.has(bucket) || (prefix && !safePath(prefix))) return send(400, { message: 'Invalid list' });
    const dirPath = join(ctx.store, bucket, prefix);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return send(200, []);
    const items = readdirSync(dirPath).filter((n) => !n.endsWith('.type')).sort()
      .map((n) => { const st = statSync(join(dirPath, n)); return st.isDirectory() ? { name: n, id: null } : { name: n, id: `local-${n}`, created_at: st.birthtime.toISOString(), metadata: { size: st.size } }; });
    const offset = Number(body.offset) || 0;
    return send(200, items.slice(offset, offset + (Number(body.limit) || 100)));
  }
  const bucket = parts[0];
  const path = parts.slice(1).join('/');
  if (!BUCKETS.has(bucket)) return send(400, { message: 'Bucket not found' });
  if (req.method === 'POST' || req.method === 'PUT') return storePut(req, ctx, bucket, path, send);
  if (req.method === 'DELETE') {
    const body = JSON.parse((await readAll(req)).toString() || '{}');
    for (const p of body.prefixes || []) if (safePath(p)) { rmSync(join(ctx.store, bucket, p), { force: true }); rmSync(join(ctx.store, bucket, p + '.type'), { force: true }); }
    return send(200, []);
  }
  return send(405, { message: 'method' });
}

/** The claims of a storage token this gateway signed, or null. */
function tokenClaims(token, ctx) {
  const [h, b, s] = String(token || '').split('.');
  if (!h || !b || !s || !same(s, b64url(createHmac('sha256', ctx.jwtSecret).update(`${h}.${b}`).digest()))) return null;
  try {
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    return claims.exp >= Date.now() / 1000 ? claims : null;
  } catch { return null; }
}

function storageSignedGet(url, res, ctx) {
  const key = decodeURIComponent(url.pathname.replace('/storage/v1/object/sign/', ''));
  const claims = tokenClaims(url.searchParams.get('token'), ctx);
  const [bucket, ...rest] = key.split('/');
  const file = join(ctx.store, bucket, rest.join('/'));
  if (!claims || claims.upload || claims.url !== key || !safePath(rest.join('/')) || !existsSync(file)) {
    res.writeHead(400, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ statusCode: '400', error: 'InvalidJWT', message: 'invalid signature' }));
    return;
  }
  const type = existsSync(file + '.type') ? readFileSync(file + '.type', 'utf8') : 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': 'max-age=3600', ...CORS };
  const name = url.searchParams.get('download');
  if (name !== null) headers['content-disposition'] = `attachment; filename="${(name || rest[rest.length - 1]).replace(/["\\\r\n]/g, '')}"`;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

function storageSignedPut(req, url, res, ctx) {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify(body)); };
  const key = decodeURIComponent(url.pathname.replace('/storage/v1/object/upload/sign/', ''));
  const claims = tokenClaims(url.searchParams.get('token'), ctx);
  const [bucket, ...rest] = key.split('/');
  if (!claims || !claims.upload || claims.url !== key || !BUCKETS.has(bucket)) return send(400, { statusCode: '400', error: 'InvalidJWT', message: 'invalid signature' });
  return storePut(req, ctx, bucket, rest.join('/'), send);
}

/**
 * The Phase 3 check suites: everything that needs the database, the API or
 * the whole app running. Registered in scripts/check.mjs.
 *
 *   schema     supabase/schema.sql stands up, locks down and keeps its promises
 *   envelope   server encryption and the browser's decryption agree (Chromium)
 *   refusals   every way a client request can be wrong gets the identical 410;
 *              record-only endpoints answer 204 whatever happened; staff
 *              endpoints refuse strangers and cross-site posts
 *   editor     the editor, driven in Chromium against the real stack
 *   flow       staff to client: sign in, publish, unlock, revise, supersede,
 *              approve a new person — the whole loop in a browser
 *
 * Each needs Postgres 16 and Docker (scripts/lib/local-supabase.mjs) and the
 * browser ones need Playwright; without them a suite reports NOT CHECKED.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSchemaProof } from '../schema-standup-check.mjs';
import { encryptRevision, rewrap } from '../../lib/envelope.js';
import { sha256 } from '../../lib/tokens.js';
import { runChecks } from '../../assets/js/checks.js';
import { FIXTURES as PDF_FIXTURES, textPdf } from './pdf-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PASS = 'pass', FAIL = 'fail', SKIP = 'not checked';
const DEMO = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/demo-proposal.json'), 'utf8'));

/* ------------------------------------------------------------ shared */

let appCtx = null;
let appWhyNot = '';
let pwCtx = null;
async function app() {
  if (appCtx !== null) return appCtx;
  try {
    const { startLocalApp, codeFor, SUPER_EMAIL, CHECK_EMAIL } = await import('../demo/local-app.mjs');
    const a = await startLocalApp({ port: 4600 + Math.floor(Math.random() * 300) });
    appCtx = a ? { ...a, codeFor, SUPER_EMAIL, CHECK_EMAIL } : false;
  } catch (e) { appCtx = false; appWhyNot = e.message; }
  return appCtx;
}
async function browser() {
  if (pwCtx !== null) return pwCtx;
  const { loadPlaywright } = await import('./browser.mjs');
  const pw = await loadPlaywright();
  pwCtx = pw ? { pw, browser: await pw.chromium.launch() } : false;
  return pwCtx;
}
export async function closeServerSuites() {
  if (pwCtx) await pwCtx.browser.close();
  if (appCtx) appCtx.stop();
}

/** A tiny API client with its own session cookie. */
function client(a) {
  let cookie = '';
  // Each test client is its own caller, as separate people would be: the
  // per-connection sign-in limits are counted by (hashed) address.
  const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
  return {
    async call(method, path, body, headers = {}) {
      const r = await fetch(a.url + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', origin: a.url, cookie, 'x-forwarded-for': ip, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, text, json, headers: r.headers };
    },
    async signIn(email) {
      await this.call('POST', '/api/auth?action=code', { email });
      const code = a.codeFor(a.outbox(), email);
      return this.call('POST', '/api/auth?action=verify', { email, code });
    },
    cookie: () => cookie,
  };
}

/**
 * A PDF attached the way the editor does it: begin (the server fixes the path),
 * PUT straight to storage, verify. Returns { status, json } from verify, or
 * from begin when that already knew the file.
 */
async function uploadPdf(c, proposal, bytes, name) {
  const sha = sha256(bytes);
  const begin = await c.call('POST', '/api/attachments', { action: 'begin', proposal, name, bytes: bytes.length, sha256: sha });
  if (begin.status !== 200 || begin.json.file) return begin;
  const put = await fetch(begin.json.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: bytes });
  if (!put.ok) return { status: put.status, json: { error: await put.text() } };
  return c.call('POST', '/api/attachments', { action: 'verify', proposal, name, sha256: sha });
}

/** A one-page test PDF, different each time it is asked for by name. */
export const testPdf = (title) => textPdf([title, 'A test file for the attachment checks. It carries no proposal content.']);

/** A demo proposal, created, with every acknowledgement given and a checked file on each document the client can open; optionally published. */
async function demoProposal(c, { publish = true, mutate } = {}) {
  const cfg = JSON.parse(JSON.stringify(DEMO));
  if (mutate) mutate(cfg);
  const { checkContext } = await import('../../lib/proposals.js');
  const created = await c.call('POST', '/api/proposals', { action: 'create', config: cfg });
  const id = created.json.id;
  const draft = await c.call('GET', `/api/drafts?id=${id}`);
  const config = draft.json.config;
  for (const card of config.attachments || []) {
    if (card.visibility !== 'client') continue;
    const up = await uploadPdf(c, id, testPdf(card.title), `${card.id}.pdf`);
    if (up.status !== 200) throw new Error(`attaching a file failed: ${up.status} ${JSON.stringify(up.json)}`);
    card.file = up.json.file.id;
  }
  const acks = runChecks(config, checkContext()).acks.map((x) => x.key);
  const put = await c.call('PUT', '/api/drafts', { id, version: draft.json.version, config: { ...config, acks } });
  if (!publish) return { id, version: put.json.version };
  const pub = await c.call('POST', '/api/proposals', { action: 'publish', id, version: put.json.version });
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.text}`);
  const u = new URL(pub.json.url);
  return { id, version: put.json.version, url: pub.json.url, slug: u.pathname.split('/')[2], t: u.searchParams.get('t'), passphrase: pub.json.passphrase };
}

const skipNoStack = () => ({ status: SKIP, detail: [`the local stack could not start (Postgres 16 and Docker)${appWhyNot ? `: ${appWhyNot}` : ''}`] });

/* ------------------------------------------------------------ schema */

export async function suiteSchema() {
  const out = await runSchemaProof();
  if (!out.ran) return { status: SKIP, detail: [out.reason] };
  const failed = out.results.filter((r) => !r.ok);
  return failed.length
    ? { status: FAIL, detail: failed.map((r) => `${r.label} → ${JSON.stringify(r.got)}`) }
    : { status: PASS, detail: [`all ${out.results.length} promises held on a fresh Postgres 16 + PostgREST`, 'anon refused every table and function; revisions immutable; logs append-only; publish/rotate races refused'] };
}

/* ------------------------------------------------------------ envelope */

export async function suiteEnvelope({ browserSession }) {
  const ctx = await browserSession();
  if (!ctx) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const text = JSON.stringify({ meta: { project: 'Rock removal — Stage 2 · 50 m from “the shed”' }, n: [1, 2, 3], unicode: 'Ōtautahi ✓' });
  const bytes = new TextEncoder().encode(text);
  const pass = 'harbour-lantern-copper-marsh-quartz-482';
  const { enc, key } = await encryptRevision(bytes, pass);
  const rewrapped = await rewrap(key, pass, 'new-words-here-and-there-001');
  const env = JSON.parse(enc);
  const tampered = JSON.stringify({ ...env, ct: Buffer.from(Buffer.from(env.ct, 'base64').map((b, i) => (i === 5 ? b ^ 1 : b))).toString('base64') });
  const page = await ctx.browser.newPage();
  await page.goto(`${ctx.base}/demo`);
  const r = await page.evaluate(async ({ enc, key, rewrapped, tampered, pass }) => {
    const { openEnvelope } = await import('/assets/js/envelope-client.js');
    const out = {};
    const o = await openEnvelope({ enc, key }, pass);
    out.text = new TextDecoder().decode(o.bytes); out.sha = o.sha;
    out.wrong = await openEnvelope({ enc, key }, pass + 'x').then(() => 'OPENED', (e) => (e.passphrase ? 'passphrase' : 'other'));
    out.newPass = await openEnvelope({ enc, key: rewrapped }, 'new-words-here-and-there-001').then((x) => new TextDecoder().decode(x.bytes), () => 'FAILED');
    out.oldPassOnNew = await openEnvelope({ enc, key: rewrapped }, pass).then(() => 'OPENED', (e) => (e.passphrase ? 'passphrase' : 'other'));
    out.tampered = await openEnvelope({ enc: tampered, key }, pass).then(() => 'OPENED', (e) => (e.passphrase ? 'passphrase' : 'refused'));
    return out;
  }, { enc, key, rewrapped, tampered, pass });
  await page.close();
  if (r.text !== text) fails.push('the browser did not recover the exact plaintext');
  if (r.sha !== sha256(bytes)) fails.push('the browser hash of the plaintext differs from the server\'s (acceptance would never match)');
  if (r.wrong !== 'passphrase') fails.push(`a wrong passphrase gave "${r.wrong}"`);
  if (r.newPass !== text) fails.push('after rotation the new passphrase did not open the unchanged ciphertext');
  if (r.oldPassOnNew !== 'passphrase') fails.push('after rotation the old passphrase still opened it');
  if (r.tampered !== 'refused') fails.push(`altered ciphertext gave "${r.tampered}" (it must be refused, not opened)`);
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: ['encrypted in Node, opened in Chromium with the gate\'s own module: exact bytes, same SHA-256', 'wrong passphrase refused; rotation re-wraps without touching the ciphertext; tampering refused'] };
}

/* ------------------------------------------------------------ refusals */

export async function suiteRefusals() {
  const a = await app();
  if (!a) return skipNoStack();
  const fails = [];
  const staff = client(a);
  await staff.signIn(a.CHECK_EMAIL);
  const live = await demoProposal(staff);
  const withdrawn = await demoProposal(staff);
  await staff.call('POST', '/api/proposals', { action: 'withdraw', id: withdrawn.id, note: 'check' });
  const expired = await demoProposal(staff);
  const { psql } = await import('./local-supabase.mjs');
  psql(a.sb.conn, `update public.texc_proposals set link_expires_at = now() - interval '1 minute' where id = '${expired.id}'`);
  const unissued = await demoProposal(staff, { publish: false });
  const unissuedSlug = (await staff.call('GET', `/api/proposals?id=${unissued.id}`)).json.slug;
  const rotated = await demoProposal(staff);
  await staff.call('POST', '/api/proposals', { action: 'rotate', id: rotated.id });

  const zero = '0'.repeat(64);
  const cases = [
    ['wrong token', live.slug, zero, ''],
    ['wrong slug', 'abcdefghij', live.t, ''],
    ['no such revision', live.slug, live.t, 'Q'],
    ['withdrawn', withdrawn.slug, withdrawn.t, ''],
    ['link expired', expired.slug, expired.t, ''],
    ['never issued', unissuedSlug, zero, ''],
    ['link rotated (old token)', rotated.slug, rotated.t, ''],
    ['malformed token', live.slug, 'nothex', ''],
    ['malformed slug', '../../etc', live.t, ''],
  ];
  const anon = client(a);
  const goodGet = await anon.call('GET', `/api/proposal?slug=${live.slug}&t=${live.t}`);
  if (goodGet.status !== 200) fails.push(`the live link itself did not open (${goodGet.status})`);
  let reference = null;
  for (const [name, slug, t, rev] of cases) {
    const q = new URLSearchParams({ slug, t, ...(rev ? { rev } : {}) });
    const g = await anon.call('GET', `/api/proposal?${q}`);
    const m = await anon.call('POST', '/api/media', { slug, t, vt: zero, rev });
    const sig = `${g.status}|${g.headers.get('content-type')}|${g.headers.get('cache-control')}|${g.text}`;
    if (reference === null) reference = sig;
    if (sig !== reference) fails.push(`${name}: GET /api/proposal answered differently: ${sig}`);
    if (`${m.status}|${m.text}` !== `410|${g.text}`) fails.push(`${name}: POST /api/media answered ${m.status} ${m.text}`);
  }
  if (!reference || !reference.startsWith('410|')) fails.push(`refusals are not 410: ${reference}`);
  // A right link with a wrong view token: media is still refused, identically.
  const wrongVt = await anon.call('POST', '/api/media', { slug: live.slug, t: live.t, vt: zero });
  if (`${wrongVt.status}|${wrongVt.text}` !== `410|${reference.split('|').slice(3).join('|')}`) fails.push(`a wrong view token got ${wrongVt.status} ${wrongVt.text}`);
  // Attachments: the same refusal for every bad link, a wrong view token, a card
  // that is only "on request", one that does not exist, and a malformed one.
  const vtOf = (id) => JSON.parse(psql(a.sb.conn, `select published_text from public.texc_proposal_revisions where proposal_id = '${id}' order by rev_index desc limit 1`)).__vt;
  const liveVt = vtOf(live.id);
  for (const [name, slug, t, rev] of cases) {
    const r = await anon.call('POST', '/api/attachment', { slug, t, vt: liveVt, rev, id: 'a1' });
    if (`${r.status}|${r.text}` !== `410|${reference.split('|').slice(3).join('|')}`) fails.push(`${name}: POST /api/attachment answered ${r.status} ${r.text}`);
  }
  for (const [name, payload] of [['a wrong view token', { vt: zero, id: 'a1' }], ['a card only available on request', { vt: liveVt, id: 'a4' }],
    ['a card that does not exist', { vt: liveVt, id: 'a9' }], ['a malformed card id', { vt: liveVt, id: '../a1' }], ['no card at all', { vt: liveVt }]]) {
    const r = await anon.call('POST', '/api/attachment', { slug: live.slug, t: live.t, ...payload });
    if (`${r.status}|${r.text}` !== `410|${reference.split('|').slice(3).join('|')}`) fails.push(`${name}: POST /api/attachment answered ${r.status} ${r.text}`);
  }
  const opened = await anon.call('POST', '/api/attachment', { slug: live.slug, t: live.t, vt: liveVt, id: 'a1' });
  const fetched = opened.status === 200 ? await fetch(opened.json.url) : null;
  const got = fetched && fetched.ok ? Buffer.from(await fetched.arrayBuffer()) : null;
  if (!got || sha256(got) !== sha256(testPdf(DEMO.attachments[0].title)) || fetched.headers.get('content-disposition')) fails.push(`the client could not open its own document, or got different bytes (${opened.status})`);
  const dl = await anon.call('POST', '/api/attachment', { slug: live.slug, t: live.t, vt: liveVt, id: 'a1', download: true });
  const dlr = dl.status === 200 ? await fetch(dl.json.url) : null;
  if (!dlr || !/attachment/.test(dlr.headers.get('content-disposition') || '') || !/\.pdf$/.test(dl.json.name) || !dl.json.name.includes(DEMO.attachments[0].title.split(' ')[0])) fails.push(`a download did not arrive as a named PDF (${dl.status} ${dl.json && dl.json.name})`);
  const opens = psql(a.sb.conn, `select string_agg(event, ',' order by id) from public.texc_events where proposal_id = '${live.id}' and event like 'attachment_%'`);
  if (opens !== 'attachment_added,attachment_added,attachment_added,attachment_opened,attachment_downloaded') fails.push(`attachment events recorded as "${opens}"`);

  // Staff side: uploads refused for strangers, viewers, the wrong file, a non-PDF, an oversize claim.
  const noSession = await anon.call('POST', '/api/attachments', { action: 'list', proposal: live.id });
  if (noSession.status !== 401) fails.push(`/api/attachments without a session answered ${noSession.status}`);
  const bigClaim = await staff.call('POST', '/api/attachments', { action: 'begin', proposal: live.id, name: 'big.pdf', bytes: 25 * 1024 * 1024 + 1, sha256: zero });
  if (bigClaim.status !== 413) fails.push(`a file over 25 MB was allowed to start uploading (${bigClaim.status})`);
  const notPdfName = await staff.call('POST', '/api/attachments', { action: 'begin', proposal: live.id, name: 'drawing.dwg', bytes: 100, sha256: zero });
  if (notPdfName.status !== 400) fails.push(`a file not named .pdf was allowed to start uploading (${notPdfName.status})`);
  const renamed = await uploadPdf(staff, live.id, PDF_FIXTURES['not a PDF (a renamed file)'].bytes(), 'renamed.pdf');
  if (renamed.status !== 422 || renamed.json.finding?.overridable !== false) fails.push(`a renamed non-PDF answered ${renamed.status} ${JSON.stringify(renamed.json).slice(0, 120)}`);
  const swapped = await staff.call('POST', '/api/attachments', { action: 'begin', proposal: live.id, name: 'swap.pdf', bytes: 2000, sha256: sha256(testPdf('Named')) });
  if (swapped.status === 200 && swapped.json.uploadUrl) {
    await fetch(swapped.json.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: testPdf('Something else') });
    const v = await staff.call('POST', '/api/attachments', { action: 'verify', proposal: live.id, name: 'swap.pdf', sha256: sha256(testPdf('Named')) });
    if (v.status !== 400) fails.push(`a file that was not the one named was accepted (${v.status})`);
  } else fails.push(`begin answered ${swapped.status}`);
  const leftovers = psql(a.sb.conn, `select count(*) from public.texc_attachments where proposal_id = '${live.id}'`);
  if (leftovers !== '3') fails.push(`refused uploads left rows behind (${leftovers} files on the proposal, expected 3)`);
  // A replaced file is a change worth naming before the next revision, even
  // when its card reads the same: two files of the same size and page count.
  const sameSize = (word) => textPdf([`Corrected copy, version ${word}`, 'A test file for the attachment checks.'], { compress: false });
  const swap = await demoProposal(staff, { publish: false });
  const one1 = await uploadPdf(staff, swap.id, sameSize('one'), 'v1.pdf');
  const two2 = await uploadPdf(staff, swap.id, sameSize('two'), 'v2.pdf');
  let sd = (await staff.call('GET', `/api/drafts?id=${swap.id}`)).json;
  sd.config.attachments[0].file = one1.json.file.id;
  let sp = await staff.call('PUT', '/api/drafts', { id: swap.id, version: sd.version, config: sd.config });
  await staff.call('POST', '/api/proposals', { action: 'publish', id: swap.id, version: sp.json.version });
  sd = (await staff.call('GET', `/api/drafts?id=${swap.id}`)).json;
  sd.config.attachments[0].file = two2.json.file.id;
  sp = await staff.call('PUT', '/api/drafts', { id: swap.id, version: sd.version, config: sd.config });
  const changes = (await staff.call('GET', `/api/proposals?id=${swap.id}&changes=1`)).json.changes || [];
  if (one1.json.file.bytes !== two2.json.file.bytes || JSON.stringify(changes) !== JSON.stringify([{ label: 'Documents and attachments', kind: 'files changed' }])) fails.push(`a file replaced by one of the same size was not named as the only change: ${JSON.stringify(changes)}`);

  // A file the check did not pass blocks publishing until an administrator releases it, with a reason, on the record.
  const gated = await demoProposal(staff, { publish: false });
  const lzw = await uploadPdf(staff, gated.id, PDF_FIXTURES['a stream in a filter the check cannot read (LZW)'].bytes(), 'scanned-drawing.pdf');
  const gd = (await staff.call('GET', `/api/drafts?id=${gated.id}`)).json;
  gd.config.attachments[0].file = lzw.json.file.id;
  const gput = await staff.call('PUT', '/api/drafts', { id: gated.id, version: gd.version, config: gd.config });
  const gpub = await staff.call('POST', '/api/proposals', { action: 'publish', id: gated.id, version: gput.json.version });
  if (lzw.json.file?.status !== 'cannot-verify' || gpub.status !== 422 || !/did not pass the check/.test(JSON.stringify(gpub.json))) fails.push(`a file that could not be verified did not block publishing (${lzw.json.file?.status}, publish ${gpub.status})`);
  const attachEditor = 'editor.attach@example.com';
  await anon.call('POST', '/api/auth?action=code', { email: attachEditor });
  await staff.call('POST', '/api/people', { email: attachEditor, status: 'active', role: 'editor' });
  const ed2 = client(a);
  await ed2.signIn(attachEditor);
  const byEditor = await ed2.call('POST', '/api/attachments', { action: 'override', proposal: gated.id, id: lzw.json.file.id, reason: 'Checked it by eye, it is a scanned drawing.' });
  if (byEditor.status !== 403) fails.push(`an editor released a file (${byEditor.status})`);
  const terse = await staff.call('POST', '/api/attachments', { action: 'override', proposal: gated.id, id: lzw.json.file.id, reason: 'ok' });
  if (terse.status !== 400) fails.push(`a release without a real reason answered ${terse.status}`);
  const cleanId = gd.config.attachments[1].file;
  const notNeeded = await staff.call('POST', '/api/attachments', { action: 'override', proposal: gated.id, id: cleanId, reason: 'Releasing a clean file should be refused.' });
  if (notNeeded.status !== 409) fails.push(`releasing a file that passed answered ${notNeeded.status}`);
  const released = await staff.call('POST', '/api/attachments', { action: 'override', proposal: gated.id, id: lzw.json.file.id, reason: 'Scanned civil drawing from the client; opened and checked by hand.' });
  const audited = psql(a.sb.conn, `select count(*) from public.texc_staff_audit where proposal_id = '${gated.id}' and action = 'attachment_released' and detail->>'reason' like 'Scanned civil drawing%'`);
  const gpub2 = await staff.call('POST', '/api/proposals', { action: 'publish', id: gated.id, version: gput.json.version });
  const snap = JSON.parse(psql(a.sb.conn, `select attachments_snapshot::text from public.texc_proposal_revisions where proposal_id = '${gated.id}'`) || '[]');
  if (released.status !== 200 || released.json.file.status !== 'override' || audited !== '1' || gpub2.status !== 200) fails.push(`releasing with a reason did not let it publish, on the record (${released.status}, audit ${audited}, publish ${gpub2.status})`);
  if (snap.length !== 3 || snap[0].released !== 'override' || snap.some((x) => !/^proposals\/[0-9a-f-]{36}\/attachments\/[0-9a-f]{16}-[a-z0-9-]+\.pdf$/.test(x.path))) fails.push(`the revision did not bind its files: ${JSON.stringify(snap).slice(0, 200)}`);
  const published = JSON.parse(psql(a.sb.conn, `select published_text from public.texc_proposal_revisions where proposal_id = '${gated.id}'`));
  if (JSON.stringify(published.attachments).match(/"file"|storage|proposals\//) || published.attachments[0].pages !== 1) fails.push(`the client's copy carries file internals, or not the measured page count: ${JSON.stringify(published.attachments[0])}`);

  // Record-only endpoints: 204 and nothing else, whatever was sent.
  for (const path of ['/api/view', '/api/event']) {
    for (const payload of [{ slug: live.slug, t: live.t, vt: zero, event: 'printed' }, { slug: 'nope', t: 'nope' }, {}]) {
      const r = await anon.call('POST', path, payload);
      if (r.status !== 204 || r.text !== '') fails.push(`${path} answered ${r.status} "${r.text}" to ${JSON.stringify(payload).slice(0, 60)}`);
    }
  }
  // Staff endpoints: no session, cross-site, wrong method.
  for (const [method, path] of [['GET', '/api/proposals'], ['GET', '/api/drafts?id=' + live.id], ['POST', '/api/proposals'], ['GET', '/api/people'], ['POST', '/api/staff-media'], ['POST', '/api/attachments']]) {
    const r = await anon.call(method, path, method === 'POST' ? { action: 'create' } : undefined);
    if (r.status !== 401) fails.push(`${method} ${path} without a session answered ${r.status}`);
  }
  const page = await anon.call('GET', '/editor');
  if (page.status !== 302 || !/^\/signin\?next=/.test(page.headers.get('location') || '')) fails.push(`/editor without a session answered ${page.status} ${page.headers.get('location')}`);
  const xs = await staff.call('POST', '/api/proposals', { action: 'create', config: {} }, { origin: 'https://evil.example' });
  if (xs.status !== 403) fails.push(`a cross-site POST with a valid session answered ${xs.status}`);
  const ok = await staff.call('GET', `/api/drafts?id=${live.id}`);
  if (ok.status !== 200) fails.push('the staff session itself stopped working');
  // A CONFIRM in a visible section is refused at publish, and nothing is written.
  const pending = await demoProposal(staff, { publish: false, mutate: (cfg) => { cfg.letter.greetingName = { $confirm: 'first name to confirm' }; } });
  const d0 = (await staff.call('GET', `/api/drafts?id=${pending.id}`)).json;
  const refused = await staff.call('POST', '/api/proposals', { action: 'publish', id: pending.id, version: d0.version });
  const after = (await staff.call('GET', `/api/proposals?id=${pending.id}`)).json;
  if (refused.status !== 422 || after.revisions.length !== 0 || after.reference) fails.push(`publishing a draft with a CONFIRM answered ${refused.status} and left ${after.revisions.length} revision(s), reference ${after.reference}`);
  // A stale draft version is refused too: what is published is what the editor saw.
  const stale = await staff.call('POST', '/api/proposals', { action: 'publish', id: live.id, version: 1 });
  if (stale.status !== 409) fails.push(`publishing from a stale draft version answered ${stale.status}`);
  // Review fixes, held: ------------------------------------------------------
  const q = (sql) => psql(a.sb.conn, sql);
  // (1) Publishing with an unlocked safety line completes, shows the passphrase, and is audited.
  const unlocked = await demoProposal(staff, { publish: false });
  let dr = (await staff.call('GET', `/api/drafts?id=${unlocked.id}`)).json;
  const cfgU = JSON.parse(JSON.stringify(dr.config));
  cfgU.scope.services[0].safetyUnlockedBy = 'someone-else@example.com';
  cfgU.scope.services[0].safety = cfgU.scope.services[0].safety || 'Reworded by an administrator for this site.';
  const putU = await staff.call('PUT', '/api/drafts', { id: unlocked.id, version: dr.version, config: cfgU });
  dr = (await staff.call('GET', `/api/drafts?id=${unlocked.id}`)).json;
  if (putU.status !== 200 || dr.config.scope.services[0].safetyUnlockedBy !== a.CHECK_EMAIL) fails.push(`an unlock was not stamped by the server with the administrator's own address (${putU.status}, ${dr.config.scope.services[0].safetyUnlockedBy})`);
  const pubU = await staff.call('POST', '/api/proposals', { action: 'publish', id: unlocked.id, version: dr.version });
  if (pubU.status !== 200 || !pubU.json.passphrase) fails.push(`publishing with an unlocked safety line answered ${pubU.status} ${pubU.text.slice(0, 120)}`);
  if (q(`select count(*) from public.texc_staff_audit where proposal_id = '${unlocked.id}' and action in ('safety_unlocked', 'published_unlocked_safety')`) !== '2') fails.push('the unlock and the unlocked publish were not both audited');
  // (3) The frozen people data carries no competency or licence lists.
  const text = q(`select published_text from public.texc_proposal_revisions where proposal_id = '${live.id}' order by rev_index limit 1`);
  const tplPeople = JSON.parse(text).tpl.people || [];
  if (!tplPeople.length || tplPeople.some((x) => 'competencies' in x || 'licences' in x)) fails.push('the published text carries the website\'s competency or licence lists');
  // (2, 4) An editor: cannot unlock a safety line, cannot bring back a withdrawn proposal.
  const editorEmail = 'editor.check@example.com';
  await anon.call('POST', '/api/auth?action=code', { email: editorEmail });
  await staff.call('POST', '/api/people', { email: editorEmail, status: 'active', role: 'editor' });
  const editor = client(a);
  await editor.signIn(editorEmail);
  const ed = await demoProposal(editor, { publish: false });
  const edDraft = (await editor.call('GET', `/api/drafts?id=${ed.id}`)).json;
  const cfgE = JSON.parse(JSON.stringify(edDraft.config));
  cfgE.scope.services[0].safetyUnlockedBy = a.CHECK_EMAIL;
  cfgE.scope.services[0].safety = 'Softer wording.';
  const putE = await editor.call('PUT', '/api/drafts', { id: ed.id, version: edDraft.version, config: cfgE });
  if (putE.status !== 403) fails.push(`an editor unlocking a safety line answered ${putE.status}`);
  const wDraft = (await editor.call('GET', `/api/drafts?id=${withdrawn.id}`)).json;
  const reE = await editor.call('POST', '/api/proposals', { action: 'publish', id: withdrawn.id, version: wDraft.version });
  if (reE.status !== 403) fails.push(`an editor re-publishing a withdrawn proposal answered ${reE.status}`);
  const reA = await staff.call('POST', '/api/proposals', { action: 'publish', id: withdrawn.id, version: wDraft.version });
  const oldLink = await anon.call('GET', `/api/proposal?slug=${withdrawn.slug}&t=${withdrawn.t}`);
  if (reA.status !== 200 || !reA.json.passphrase || reA.json.url.includes(withdrawn.t) || oldLink.status !== 410) fails.push(`re-issuing a withdrawn proposal did not give a new link and passphrase with the old link dead (${reA.status}, old ${oldLink.status})`);
  // (5) Six wrong codes and the real one no longer works.
  const guessEmail = 'guess.check@example.com';
  await anon.call('POST', '/api/auth?action=code', { email: guessEmail });
  await staff.call('POST', '/api/people', { email: guessEmail, status: 'active', role: 'viewer' });
  await anon.call('POST', '/api/auth?action=code', { email: guessEmail });
  const realCode = a.codeFor(a.outbox(), guessEmail);
  const guesser = client(a);
  for (let i = 0; i < 6; i += 1) await guesser.call('POST', '/api/auth?action=verify', { email: guessEmail, code: realCode === '000000' ? '111111' : '000000' });
  const late = await guesser.call('POST', '/api/auth?action=verify', { email: guessEmail, code: realCode });
  if (late.status === 200) fails.push('after six wrong guesses the real code still signed in');
  // (7) A Brand in Black account's stored row has no standing of its own.
  const row = q(`select role || '/' || status from public.texc_users where email = '${a.CHECK_EMAIL}'`);
  if (row !== 'viewer/suspended') fails.push(`a super's stored row is ${row} (it must carry no standing of its own)`);
  // ---------------------------------------------------------------------------

  // A viewer cannot edit or publish.
  const viewerEmail = 'viewer.check@example.com';
  await anon.call('POST', '/api/auth?action=code', { email: viewerEmail });
  await staff.call('POST', '/api/people', { email: viewerEmail, status: 'active', role: 'viewer' });
  const viewer = client(a);
  await viewer.signIn(viewerEmail);
  const vr = await viewer.call('GET', '/api/proposals');
  if (vr.status !== 403) fails.push(`a viewer listing proposals for editing answered ${vr.status}`);
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [
    `${cases.length} kinds of bad link (wrong token, withdrawn, expired, rotated, never issued…) get byte-identical 410s from /api/proposal, /api/media and /api/attachment`,
    'documents: a wrong view token, an "on request" card or an unknown one get the same 410; the client\'s own opens with the exact bytes, downloads by name, and both are logged',
    'uploads: a renamed non-PDF is refused and not kept, a swapped file is refused, an oversize or non-PDF name never starts; a replaced file is named in the next revision\'s changes',
    'a file that could not be verified blocks publishing until an administrator releases it with a reason (editors refused, audited); the revision binds its files and the client copy carries none of their internals',
    'view and event answer 204 with no body, whatever is sent; staff endpoints answer 401 without a session',
    'publishing a CONFIRM is refused (422) with nothing written; a stale draft version is refused (409)',
    'safety unlocks: editors refused, administrators stamped by the server, the unlocked publish completes and is audited',
    'a withdrawn proposal comes back only through an administrator, behind a new link; six wrong codes kill the real one',
    'cross-site POST refused with a valid session; a viewer cannot open proposals for editing',
  ] };
}

/* ------------------------------------------------------------ browser helpers */

// Signed in through the real sign-in page once; later contexts reuse that session.
let staffState = null;
async function signedInContext(a, b, { width = 1440, height = 900, scale = 1 } = {}) {
  const ctx = await b.browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', ...(staffState ? { storageState: staffState } : {}) });
  const page = await ctx.newPage();
  const problems = [];
  // A 410 (a dead link), a 409 (the deliberate two-editor conflict) and a 422 (a file refused outright) are expected responses, not faults.
  page.on('console', (m) => { if ((m.type() === 'error' && !/status of 4(10|09|22)/.test(m.text())) || /Content Security Policy/i.test(m.text())) problems.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => problems.push('script error: ' + e.message));
  // Confirms are accepted; a prompt is answered from page.promptAnswers (a test pushes the answer first).
  page.promptAnswers = [];
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (page.promptAnswers.shift() ?? '') : undefined));
  if (staffState) {
    await page.goto(`${a.url}/editor`);
    return { ctx, page, problems };
  }
  await page.goto(`${a.url}/signin?next=/editor`);
  await page.fill('#email', a.SUPER_EMAIL);
  await page.click('#email-form button');
  await page.waitForSelector('[data-step="code"]:not([hidden])');
  await page.fill('#code', a.codeFor(a.outbox(), a.SUPER_EMAIL));
  await page.click('#code-form button');
  await page.waitForURL((u) => new URL(u).pathname === '/editor');
  staffState = await ctx.storageState();
  return { ctx, page, problems };
}

async function createFromDemo(page) {
  return page.evaluate(async () => {
    const f = await (await fetch('/api/editor?fixture=demo')).json();
    const r = await fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', config: f }) });
    const j = await r.json();
    if (!j.id) throw new Error(`create answered ${r.status}: ${JSON.stringify(j)}`);
    return j.id;
  });
}

/**
 * Attach a file to document card i through the editor's own file input, and
 * wait for its verdict: the card's state once the file is stored and checked
 * (or 'error' when it was refused outright).
 */
export async function attachInEditor(page, i, name, buffer) {
  const before = await page.evaluate((n) => window.__editor.state.cfg.attachments[n].file || '', i);
  await page.setInputFiles(`[data-path="attachments.${i}.file"] input[type=file]`, { name, mimeType: 'application/pdf', buffer });
  await page.waitForFunction(([n, was]) => {
    const box = document.querySelector(`[data-path="attachments.${n}.file"]`);
    const now = window.__editor.state.cfg.attachments[n].file || '';
    return box && (box.dataset.state === 'error' || (now && now !== was && box.dataset.state !== 'busy'));
  }, [i, before], { timeout: 30000 });
  return page.getAttribute(`[data-path="attachments.${i}.file"]`, 'data-state');
}

/* ------------------------------------------------------------ editor */

export async function suiteEditor() {
  const a = await app();
  if (!a) return skipNoStack();
  const b = await browser();
  if (!b) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { ctx, page, problems } = await signedInContext(a, b);
  const id = await createFromDemo(page);
  await page.goto(`${a.url}/editor/${id}`);
  await page.waitForFunction(() => window.__editor && document.querySelectorAll('.ed-panel').length === 20 && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  const cfg = () => page.evaluate(() => window.__editor.state.cfg);
  const blockers = () => page.evaluate(() => window.__editor.state.checks.blockers.map((x) => x.message));
  const settle = () => page.waitForTimeout(350);
  await settle();

  await page.fill('[data-path="meta.project"] input', 'Controlled rock removal, Stage 3');
  await settle();
  expect(await page.textContent('.cover-title span') === 'Controlled rock removal, Stage 3', 'typing the project did not update the cover');

  await page.click('.ed-panel[data-sec="about"] .ed-switch');
  await settle();
  expect(await page.evaluate(() => document.getElementById('about').hidden), 'the show/hide switch did not reach the page');
  await page.focus('.ed-panel[data-sec="site"] .ed-handle');
  await page.keyboard.press('Alt+ArrowUp');
  await settle();
  const order = (await cfg()).layout.sections.map((x) => x.id);
  expect(order.indexOf('site') < order.indexOf('scope') && order[0] === 'cover' && order.at(-1) === 'contact', 'Alt+Up did not reorder (or moved a pinned section)');

  await page.click('.ed-panel[data-sec="risk"] .ed-panel-toggle');
  await settle();
  const n0 = (await cfg()).risk.hazards.length;
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] .ed-row .ed-danger >> nth=0');
  await settle();
  await page.click('#ed-toast button');
  await settle();
  expect((await cfg()).risk.hazards.length === n0, 'delete then Undo did not restore the hazard');
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] > .ed-rows-tools > button >> nth=0');
  await settle();
  expect((await blockers()).some((m) => /Hazard \d+ is empty/.test(m)), 'an empty hazard row did not block publishing');
  await page.click('.ed-panel[data-sec="risk"] [data-path="risk.hazards"] .ed-row .ed-danger >> nth=-1');
  await settle();

  await page.click('.ed-panel[data-sec="letter"] .ed-panel-toggle');
  await settle();
  const greet = '.ed-panel[data-sec="letter"] [data-path="letter.greetingName"]';
  const before = (await cfg()).letter.greetingName;
  await page.click(`${greet} .ed-flag`);
  await settle();
  expect((await cfg()).letter.greetingName?.suggested === before && await page.isVisible('#letter mark.confirm'), 'CONFIRM lost the text or did not show in the preview');
  await page.click(`${greet} .ed-linkbtn:has-text("Confirmed")`);
  await settle();
  expect((await cfg()).letter.greetingName === before, '"Confirmed — use this text" did not restore it');

  // Upload a photograph: resized in the browser, stored on the server, previewed.
  await page.click('[data-path="cover.image"] button:has-text("Change")');
  await page.waitForSelector('dialog .ed-photo');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--gold'); g.fillRect(0, 0, 2400, 1600); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--ink'); g.fillRect(200, 200, 900, 600); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('dialog input[type=file]', { name: 'stage-3-corridor.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => { const c = window.__editor.state.cfg; const id = c.cover?.image?.id || ''; return /^u-/.test(id) && c.media[id] && !c.media[id].pending; }, null, { timeout: 20000 });
  expect((await blockers()).some((m) => /no alt text/.test(m)), 'a new photograph without alt text did not block publishing');
  await page.fill('[data-path="cover.image"] input >> nth=0', 'Rock face in the Stage 3 corridor');
  await settle();

  // Documents: attached through the panel, each file checked, the verdict on its card.
  await page.click('.ed-panel[data-sec="attachments"] .ed-panel-toggle');
  await settle();
  const attach = (i, name, buffer) => attachInEditor(page, i, name, buffer);
  const boxText = (i) => page.textContent(`[data-path="attachments.${i}.file"]`);
  expect(await attach(0, 'scanned-drawing.pdf', PDF_FIXTURES['a stream in a filter the check cannot read (LZW)'].bytes()) === 'cannot-verify', 'a file the check cannot read was not shown as "could not be verified"');
  expect((await blockers()).some((m) => /did not pass the check/.test(m)), 'a file that could not be verified did not block publishing');
  page.promptAnswers.push('Scanned civil drawing from the client; opened and checked by hand.');
  await page.click('[data-path="attachments.0.file"] button:has-text("Release")');
  await page.waitForFunction(() => document.querySelector('[data-path="attachments.0.file"]')?.dataset.state === 'override', null, { timeout: 10000 });
  expect(/Scanned civil drawing/.test(await boxText(0)) && !(await blockers()).some((m) => /did not pass/.test(m)), 'releasing with a reason did not clear the blocker, or the reason is not on the card');
  expect(await attach(1, 'form-with-calculations.pdf', PDF_FIXTURES['/JavaScript inside a compressed object stream'].bytes()) === 'rejected' && /JavaScript/.test(await boxText(1)), 'a PDF with JavaScript was not refused, or the card does not say why');
  expect(await attach(1, 'form-flattened.pdf', PDF_FIXTURES['clean, three pages'].bytes()) === 'clean' && /3 pages/.test(await boxText(1)), 'a flattened copy did not replace the refused file');
  expect(await attach(2, 'renamed-photo.pdf', PDF_FIXTURES['not a PDF (a renamed file)'].bytes()) === 'error' && /Nothing was kept/.test(await boxText(2)), 'a renamed non-PDF was not refused outright');
  expect(await attach(2, 'stage-2-corridor-drawing.pdf', testPdf('Stage 2 corridor drawing')) === 'clean', 'a clean PDF was not accepted');
  expect(!(await blockers()).some((m) => /attachment|file/i.test(m)), `documents still block publishing: ${(await blockers()).join('; ')}`);
  await page.click('[data-path="attachments.1.file"] button:has-text("Preview")');
  await page.waitForSelector('dialog.viewer figure[data-drawn]', { timeout: 20000 });
  expect(await page.$$eval('dialog.viewer figure', (f) => f.length) === 3, 'the preview did not lay out every page');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.viewer'), null, { timeout: 5000 });

  // Checklist to Ready, then the autosave holds across a reload.
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  expect(/Ready to publish/.test(await page.textContent('dialog .ed-verdict')) && !(await page.isDisabled('#ck-publish')), 'acknowledging everything did not reach "Ready" with Publish enabled');
  await page.click('dialog .ed-dialog-head button');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 });
  await page.reload();
  await page.waitForFunction(() => window.__editor && window.__editor.state.cfg && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  await settle();
  const after = await cfg();
  expect(after.meta.project === 'Controlled rock removal, Stage 3' && after.acks && after.acks.length > 0, 'the draft did not come back from the server after a reload');
  expect(await page.evaluate(() => document.querySelector('img[data-img="cover.image"]').currentSrc.length > 0), 'the uploaded cover did not show after a reload');

  // Two people at once: the second save is refused, never silently overwritten.
  const ctx2 = await b.browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await ctx.storageState() });
  const page2 = await ctx2.newPage();
  page2.on('dialog', (d) => d.accept());
  await page2.goto(`${a.url}/editor/${id}`);
  await page2.waitForFunction(() => window.__editor && window.__editor.state.cfg && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  await page2.fill('[data-path="meta.project"] input', 'Their version of the title');
  await page2.keyboard.press('Control+s');
  await page2.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 });
  await page.fill('[data-path="meta.project"] input', 'My version of the title');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('dialog:has-text("Someone else saved")', { timeout: 10000 }).catch(async (e) => {
    const seen = await page.evaluate(() => ({ saved: document.getElementById('ed-saved').textContent, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.textContent.slice(0, 120)) }));
    throw new Error(`no conflict dialog: ${JSON.stringify(seen)}`);
  });
  await page.click('dialog button:has-text("Load theirs")');
  await page.waitForFunction(() => window.__editor.state.cfg.meta.project === 'Their version of the title', null, { timeout: 10000 });
  expect(true, '');
  await ctx2.close();

  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('ed')).display === 'none'), 'the drawer shows in print');
  await page.emulateMedia({ media: 'screen' });
  await ctx.close();
  fails.push(...problems);

  // Phone.
  const phone = await signedInContext(a, b, { width: 390, height: 844, scale: 2 });
  await phone.page.goto(`${a.url}/editor/${id}`);
  await phone.page.waitForFunction(() => window.__editor && window.__editor.state.cfg && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  const lay = await phone.page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { drawer: r('#ed').width, overlap: r('.ed-brand').right > r('.ed-top-actions').left + 1, wide: document.getElementById('ed').scrollWidth > window.innerWidth };
  });
  expect(lay.drawer === 390 && !lay.overlap && !lay.wide, `phone layout: drawer ${lay.drawer}px, header overlap ${lay.overlap}, too wide ${lay.wide}`);
  await phone.page.click('#ed-mode-preview');
  expect(await phone.page.evaluate(() => getComputedStyle(document.getElementById('ed')).display === 'none'), 'Preview did not show the page');
  await phone.ctx.close();
  fails.push(...phone.problems);

  return fails.filter(Boolean).length ? { status: FAIL, detail: fails.filter(Boolean) } : { status: PASS, detail: [
    'typing, show/hide, keyboard reorder, rows with undo, CONFIRM flag and restore',
    'upload resized, stored on the server and previewed; new photo blocks without alt; checklist reaches Ready',
    'documents attached through the panel: a script-carrying PDF refused and replaced by a clean copy, a renamed file refused outright, one that could not be verified released by an administrator with a reason; the preview draws its pages',
    'autosave to the server survives a reload; a colleague\'s save is never silently overwritten; phone layout holds',
  ] };
}

/* ------------------------------------------------------------ flow */

export async function suiteFlow() {
  const a = await app();
  if (!a) return skipNoStack();
  const b = await browser();
  if (!b) return { status: SKIP, detail: ['Playwright not found'] };
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { ctx, page, problems } = await signedInContext(a, b);
  const id = await createFromDemo(page);
  await page.goto(`${a.url}/editor/${id}`);
  await page.waitForFunction(() => window.__editor && window.__editor.state.cfg && window.__editor.state.filesLoaded, null, { timeout: 15000 });
  // A photograph of the site, uploaded: the client must see it too, through a signed link.
  await page.click('[data-path="cover.image"] button:has-text("Change")');
  await page.waitForSelector('dialog .ed-photo');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1800; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--steel-500') || 'gray'; g.fillRect(0, 0, 1800, 1200); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('dialog input[type=file]', { name: 'site-walk.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => { const c = window.__editor.state.cfg; const i = c.cover?.image?.id || ''; return /^u-/.test(i) && c.media[i] && !c.media[i].pending; }, null, { timeout: 20000 });
  await page.fill('[data-path="cover.image"] input >> nth=0', 'The Stage 2 corridor from the north');
  await page.waitForTimeout(400);

  // Documents. One of TEXC's own suite PDFs is refused (its calculation
  // scripts); a flattened copy of it passes. Without the sibling checkout or
  // poppler, built files stand in for both, and the detail says so.
  await page.click('.ed-panel[data-sec="attachments"] .ed-panel-toggle');
  await page.waitForTimeout(300);
  // The first document in the suite register, as issued (its file name starts with its id).
  const firstDoc = JSON.parse(readFileSync(resolve(ROOT, 'content/register.json'), 'utf8')).documents[0];
  const suiteDir = resolve(ROOT, '../texc/documents/exemplars/pdf');
  const suiteName = existsSync(suiteDir) ? readdirSync(suiteDir).find((n) => n.startsWith(`${firstDoc.id}_`)) : null;
  const suitePdf = suiteName ? resolve(suiteDir, suiteName) : '';
  let original = PDF_FIXTURES['/JavaScript inside a compressed object stream'].bytes();
  let flattened = PDF_FIXTURES['clean, three pages'].bytes();
  let usedSuite = false;
  if (suitePdf && spawnSync('pdftocairo', ['-v']).status !== null) {
    const flatPath = resolve(ROOT, `demo-out/attachments-check/${firstDoc.id}-flow-flattened.pdf`);
    mkdirSync(dirname(flatPath), { recursive: true });
    if (spawnSync('pdftocairo', ['-pdf', suitePdf, flatPath]).status === 0) { original = readFileSync(suitePdf); flattened = readFileSync(flatPath); usedSuite = true; }
  }
  expect(await attachInEditor(page, 0, suiteName || 'suite-form.pdf', original) === 'rejected', 'a suite PDF with calculation scripts was not refused');
  expect(await attachInEditor(page, 0, (suiteName || 'suite-form.pdf').replace(/\.pdf$/, '_flattened.pdf'), flattened) === 'clean', 'its flattened copy did not pass');
  const understanding = testPdf('Project understanding - test file');
  expect(await attachInEditor(page, 1, 'project-understanding.pdf', understanding) === 'clean', 'a clean PDF did not pass');
  expect(await attachInEditor(page, 2, 'stage-2-corridor.pdf', testPdf('Stage 2 corridor drawing - test file')) === 'clean', 'a clean PDF did not pass');
  await page.click('#ed-check');
  await page.waitForSelector('dialog .ed-verdict');
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.check('#ck-email');
  const mailBefore = a.outbox().length;
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Published")', { timeout: 30000 });
  const codes = await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent));
  const [link, pass] = codes;
  expect(/\/p\/[a-z0-9]{10}\?t=[a-f0-9]{64}$/.test(link) && /^([a-z]+-){5}\d{3}$/.test(pass || ''), 'publishing did not show a link and a passphrase');
  const sent = a.outbox().slice(mailBefore);
  expect(sent.some((m) => m.subject.startsWith('Proposal:')) && !sent.some((m) => JSON.stringify(m).includes(pass)), 'the link was not emailed, or the email contained the passphrase');
  await page.click('dialog .ed-dialog-head button');

  const cctx = await b.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const cp = await cctx.newPage();
  const cproblems = [];
  cp.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) cproblems.push(m.text().slice(0, 200)); });
  cp.on('pageerror', (e) => cproblems.push('script error: ' + e.message));
  await cp.goto(link);
  await cp.waitForSelector('#gate-form');
  expect(await cp.evaluate(() => getComputedStyle(document.getElementById('main')).display === 'none' && !document.body.innerText.includes('Ashgrove')), 'something of the proposal showed before unlocking');
  await cp.fill('#gate-pass', 'wrong-passphrase-entirely-000');
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.getElementById('gate-msg').textContent.length > 5, null, { timeout: 15000 });
  const t0 = Date.now();
  await cp.fill('#gate-pass', pass);
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.documentElement.classList.contains('unlocked'), null, { timeout: 15000 });
  const unlockMs = Date.now() - t0;
  expect(/^[A-Z]+-P-\d{4}-\d{3}$/.test((await cp.textContent('[data-field="meta.reference"]')).trim()), 'the unlocked page does not show its reference');
  await cp.waitForFunction(() => { const i = document.querySelector('img[data-img="cover.image"]'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 }).catch(() => {});
  const cover = await cp.evaluate(() => { const i = document.querySelector('img[data-img="cover.image"]'); return { src: i.currentSrc, w: i.naturalWidth, alt: i.alt }; });
  expect(/\/storage\/v1\/object\/sign\/texc-media\//.test(cover.src) && cover.w > 0 && cover.alt === 'The Stage 2 corridor from the north', `the uploaded cover did not reach the client through a signed link (${cover.src.slice(0, 80)}, ${cover.w}px)`);
  // Documents: one opens in the viewer, then in a new tab; another downloads. Each is recorded.
  await cp.click('#attachments [data-attachment="a1"][data-action="view"]');
  await cp.waitForSelector('dialog.viewer figure[data-drawn]', { timeout: 30000 });
  const ink = await cp.evaluate(() => {
    const c = document.querySelector('dialog.viewer figure[data-drawn] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 64) if (d[i] < 160) dark += 1;
    return { width: c.width, dark, pages: document.querySelectorAll('dialog.viewer figure').length };
  });
  expect(ink.dark > 40 && ink.width >= 600, `the viewer drew a blank or tiny page (${JSON.stringify(ink)})`);
  const tabUrls = [];
  cctx.on('request', (r) => { if (/\/texc-attachments\//.test(r.url())) tabUrls.push(r.url()); });
  const [tab] = await Promise.all([cctx.waitForEvent('page'), cp.click('dialog.viewer button:has-text("Open in new tab")')]);
  await cp.waitForTimeout(1500);
  expect(tabUrls.some((u) => /\/storage\/v1\/object\/sign\/texc-attachments\//.test(u) && !/download=/.test(u)), 'Open in new tab did not point the new tab at the document');
  await tab.close();
  await cp.keyboard.press('Escape');
  await cp.waitForFunction(() => !document.querySelector('dialog.viewer'), null, { timeout: 5000 });
  expect(await cp.evaluate(() => document.activeElement && document.activeElement.dataset.attachment === 'a1'), 'closing the viewer did not return focus to the button that opened it');
  const [dl] = await Promise.all([cp.waitForEvent('download', { timeout: 20000 }), cp.click('#attachments [data-attachment="a2"][data-action="download"]')]);
  const dlBytes = readFileSync(await dl.path());
  expect(sha256(dlBytes) === sha256(understanding) && /^[A-Z]+-P-\d{4}-\d{3} .+\.pdf$/.test(dl.suggestedFilename()), `the download was not the attached file under a proper name (${dl.suggestedFilename()})`);
  const { psql } = await import('./local-supabase.mjs');
  const docEvents = psql(a.sb.conn, `select string_agg(event || ':' || (meta->>'card'), ',' order by id) from public.texc_events where proposal_id = '${id}' and event in ('attachment_opened', 'attachment_downloaded')`);
  expect(docEvents === 'attachment_opened:a1,attachment_opened:a1,attachment_downloaded:a2', `document events recorded as "${docEvents}"`);

  const fp = await cp.evaluate(() => window.proposalFingerprint());
  expect(/^[a-f0-9]{64}$/.test(fp), 'the plaintext fingerprint was not kept for acceptance');
  await page.waitForTimeout(400);
  const summary = await page.evaluate(async (pid) => (await fetch(`/api/proposals?id=${pid}`)).json(), id);
  expect(summary.openCount === 1 && a.outbox().some((m) => m.subject.startsWith('Opened:')), `the open was not recorded or the office not told (${summary.openCount})`);

  // Revise: same link, Rev B; Rev A still opens, marked superseded.
  const why = async (what) => { const seen = await page.evaluate(() => ({ saved: document.getElementById('ed-saved').textContent, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.textContent.slice(0, 300)) })); return new Error(`${what}: ${JSON.stringify(seen)}`); };
  await page.fill('[data-path="meta.project"] input', 'Proposed specialist controlled rock removal, Stage 2');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 }).catch(async () => { throw await why('the revision did not save'); });
  await page.click('#ed-check');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog .ed-ck')].some((s) => /Changes since/.test(s.textContent) && /Cover/.test(s.textContent)), null, { timeout: 10000 }).catch(async () => { throw await why('the checklist did not list the change'); });
  await page.fill('#ck-note', 'Stage 2 named in the title');
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Rev B")', { timeout: 30000 });
  expect(!(await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent))).includes(pass), 'a later revision showed the passphrase again (it should only on first issue)');
  await page.click('dialog .ed-dialog-head button');
  await cp.goto(link);
  await cp.fill('#gate-pass', pass);
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.documentElement.classList.contains('unlocked'), null, { timeout: 15000 });
  expect((await cp.textContent('[data-field="meta.revLabel"]')).includes('B') && /Stage 2/.test(await cp.textContent('.cover-title')), 'the same link did not open Rev B');
  await cp.click('[data-revision-links] a:has-text("Rev A")');
  await cp.waitForFunction(() => !document.getElementById('superseded').hidden, null, { timeout: 15000 });
  expect(!/Stage 2/.test(await cp.textContent('.cover-title')), 'Rev A did not show its own content');

  // Rotate: the old link dies at once.
  page.once('dialog', (d) => d.accept());
  const rot = await page.evaluate(async (pid) => (await fetch('/api/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rotate', id: pid }) })).json(), id);
  const dead = await cctx.newPage();
  await dead.goto(link);
  await dead.waitForSelector('[data-gate="gone"]:not([hidden])', { timeout: 10000 });
  expect(rot.url && rot.url !== link, 'rotation did not issue a new link');
  await dead.close();

  // A new person asks for access, an admin approves, they can sign in.
  const newbie = 'new.estimator@example.com';
  await fetch(`${a.url}/api/auth?action=code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: newbie }) });
  expect(a.outbox().some((m) => m.subject.includes('has asked for access')), 'administrators were not told about the access request');
  await page.click('#ed-menu');
  await page.click('dialog .ed-menu-item:has-text("People")');
  await page.waitForSelector(`dialog .ed-person.is-pending:has-text("${newbie}")`);
  await page.selectOption(`dialog .ed-person:has-text("${newbie}") select`, 'editor');
  await page.waitForTimeout(400);
  await page.click(`dialog .ed-person:has-text("${newbie}") button:has-text("Approve")`);
  await page.waitForSelector(`dialog .ed-person.is-active:has-text("${newbie}")`, { timeout: 10000 });
  expect(a.outbox().some((m) => m.to.includes(newbie) && /you have access/.test(m.subject)), 'the approved person was not emailed');

  await ctx.close();
  await cctx.close();
  fails.push(...problems, ...cproblems);
  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [
    `staff sign in, publish from the checklist, link emailed without the passphrase; client unlocks at 390 in ${unlockMs} ms`,
    'an uploaded cover reaches the client through a one-hour signed link from the private bucket',
    `documents: ${usedSuite ? `${firstDoc.id} as issued` : `a built PDF with scripts (no sibling checkout or poppler, so not ${firstDoc.id})`} refused, its flattened copy passes; on a phone the client's viewer draws the pages, opens a new tab on the file, downloads another under the proposal's reference, all recorded`,
    'the open is recorded and the office told; Rev B behind the same link; Rev A opens marked superseded',
    'rotation kills the old link at once; an access request reaches admins, is approved, and the person is emailed',
  ] };
}

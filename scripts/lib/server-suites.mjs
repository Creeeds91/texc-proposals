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
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

// One signed-in API client for the checks account, shared by the API suites:
// sign-in codes are limited per address, as in production.
let checkStaffClient = null;
async function checkStaff(a) {
  if (checkStaffClient) return checkStaffClient;
  const c = client(a);
  await c.signIn(a.CHECK_EMAIL);
  checkStaffClient = c;
  return c;
}

export async function suiteRefusals() {
  const a = await app();
  if (!a) return skipNoStack();
  const fails = [];
  const staff = await checkStaff(a);
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
  // The security review of 14 Oct 2026: a hash that shares the first 16
  // characters with an issued file's, and its name, must not reach that file.
  const issued = JSON.parse(psql(a.sb.conn, `select row_to_json(x)::text from (select sha256, original_name from public.texc_attachments where proposal_id = '${live.id}' order by created_at limit 1) x`));
  const twin = issued.sha256.slice(0, 16) + 'f'.repeat(48);
  const collide = await staff.call('POST', '/api/attachments', { action: 'verify', proposal: live.id, name: issued.original_name, sha256: twin });
  const afterTwin = await anon.call('POST', '/api/attachment', { slug: live.slug, t: live.t, vt: liveVt, id: 'a1' });
  const still = afterTwin.status === 200 ? await fetch(afterTwin.json.url) : null;
  const stillBytes = still && still.ok ? Buffer.from(await still.arrayBuffer()) : null;
  if (collide.status !== 404 || !stillBytes || sha256(stillBytes) !== sha256(testPdf(DEMO.attachments[0].title))) fails.push(`a verify naming a look-alike hash touched an issued file (${collide.status}, the client then got ${afterTwin.status})`);
  // Uploads begun and never checked are swept, never a recorded file.
  const { storedCount, sweepUnrecorded } = await import('../../lib/attachments.js');
  const { db: dbOf } = await import('../../lib/db.js');
  const storedBefore = await storedCount(live.id);
  for (const word of ['orphan one', 'orphan two']) {
    const bytes = testPdf(word);
    const begun = await staff.call('POST', '/api/attachments', { action: 'begin', proposal: live.id, name: `${word.replace(' ', '-')}.pdf`, bytes: bytes.length, sha256: sha256(bytes) });
    if (begun.json && begun.json.uploadUrl) await fetch(begun.json.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: bytes });
  }
  const withOrphans = await storedCount(live.id);
  await sweepUnrecorded(dbOf(), live.id); // too young: an upload link could still be on its way
  const young = await storedCount(live.id);
  // A file being checked has a pending record, and is never swept from under its check.
  const claimed = testPdf('being checked');
  const cbegin = await staff.call('POST', '/api/attachments', { action: 'begin', proposal: live.id, name: 'being-checked.pdf', bytes: claimed.length, sha256: sha256(claimed) });
  if (cbegin.json && cbegin.json.uploadUrl) await fetch(cbegin.json.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: claimed });
  psql(a.sb.conn, `insert into public.texc_attachments (proposal_id, storage_path, original_name, sha256, scan_status, uploaded_by) values ('${live.id}', 'proposals/${live.id}/attachments/${sha256(claimed)}-being-checked.pdf', 'being-checked.pdf', '${sha256(claimed)}', 'pending', 'check')`);
  await sweepUnrecorded(dbOf(), live.id, { minAgeMs: 0 });
  const swept = await storedCount(live.id);
  const finished = await staff.call('POST', '/api/attachments', { action: 'verify', proposal: live.id, name: 'being-checked.pdf', sha256: sha256(claimed) });
  const reopened = await anon.call('POST', '/api/attachment', { slug: live.slug, t: live.t, vt: liveVt, id: 'a1' });
  if (withOrphans !== storedBefore + 2 || young !== withOrphans || swept !== storedBefore + 1 || finished.status !== 200 || finished.json.file.status !== 'clean' || reopened.status !== 200) {
    fails.push(`sweeping unchecked uploads: ${storedBefore} → ${withOrphans} → (too young) ${young} → ${swept} with one being checked; that check then ${finished.status} ${finished.json && finished.json.file && finished.json.file.status}; the client's document ${reopened.status}`);
  }
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
  if (snap.length !== 3 || snap[0].released !== 'override' || snap.some((x) => !/^proposals\/[0-9a-f-]{36}\/attachments\/[0-9a-f]{64}-[a-z0-9-]+\.pdf$/.test(x.path))) fails.push(`the revision did not bind its files: ${JSON.stringify(snap).slice(0, 200)}`);
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

/* ------------------------------------------------------------ acceptance */

/** A real PNG of w×h, as a canvas would make one: a dark stroke on white. */
function pngOf(w, h) {
  const row = (y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xff).map((v, i) => (Math.abs(y - h / 2) < 3 && i % 3 === 0 && i > w / 2 ? 0x11 : v))]);
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => row(y)));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlibCrc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Acceptance through the API, as a client page and the office would drive it:
 * the uniform refusals, form problems, a tampered total, twenty simultaneous
 * acceptances, the stored record and its fingerprint, the emails, re-acceptance
 * after a new revision, drawn and typed signatures, a staff-recorded
 * acceptance, and requests for changes.
 */
export async function suiteAcceptance() {
  const a = await app();
  if (!a) return skipNoStack();
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { psql } = await import('./local-supabase.mjs');
  const q = (sql) => psql(a.sb.conn, sql);
  const staff = await checkStaff(a);
  const anon = client(a);
  const zero = '0'.repeat(64);
  const revOf = (id, label) => JSON.parse(q(`select row_to_json(r)::text from (select published_text, plaintext_sha256 from public.texc_proposal_revisions where proposal_id = '${id}' ${label ? `and rev_label = '${label}'` : ''} order by rev_index desc limit 1) r`));
  const facts = (p, label) => { const r = revOf(p.id, label); return { vt: JSON.parse(r.published_text).__vt, sha: r.plaintext_sha256 }; };
  const person = { name: 'Sam Whitlock', position: 'Project Manager', company: 'Ashgrove Civil Pty Ltd', email: 'sam.whitlock@example.com' };
  const { quoteTotals } = await import('../../assets/js/money.js');
  const totalOf = (opts = []) => quoteTotals(DEMO.quote.lines, opts).total;
  const accept = (c, p, extra = {}, f = facts(p)) => c.call('POST', '/api/accept', {
    slug: p.slug, t: p.t, vt: f.vt, action: 'accept', ...person, authority: true, accept: true, typed: person.name,
    options: [], totalCents: totalOf(), plaintextSha256: f.sha, session: 'check-session', ...extra,
  });
  const goneBody = '{"error":"gone"}';

  // 1. Refusals: the same 410 for every way a request can be wrong.
  const live = await demoProposal(staff);
  const lf = facts(live);
  const st0 = await anon.call('POST', '/api/accept', { slug: live.slug, t: live.t, vt: lf.vt, action: 'status' });
  expect(st0.status === 200 && st0.json.open === true && st0.json.accepted === null && st0.json.earlier === null, `status before acceptance: ${st0.text}`);
  for (const [name, payload] of [
    ['a wrong token', { t: zero }], ['a wrong view token', { vt: zero }], ['bytes other than the published ones', { plaintextSha256: zero }],
    ['a malformed slug', { slug: '../x' }], ['an earlier revision that does not exist', { rev: 'Q' }],
  ]) {
    const r = await accept(anon, live, payload);
    expect(r.status === 410 && r.text === goneBody, `${name}: answered ${r.status} ${r.text.slice(0, 80)}`);
  }
  const noAction = await anon.call('POST', '/api/accept', { slug: live.slug, t: live.t, vt: lf.vt });
  expect(noAction.status === 410, `a request with no action answered ${noAction.status}`);

  // 2. Form problems name the fields; a tampered total is refused; nothing is written.
  const prob = async (extra, field) => {
    const r = await accept(client(a), live, extra);
    expect(r.status === 422 && (r.json.fields || []).includes(field), `expected a 422 naming ${field}, got ${r.status} ${r.text.slice(0, 120)}`);
  };
  await prob({ name: '' }, 'name');
  await prob({ email: 'not-an-email' }, 'email');
  await prob({ authority: false }, 'authority');
  await prob({ accept: 'yes' }, 'accept');
  await prob({ typed: 'Someone Else' }, 'typed');
  await prob({ typed: '', drawn: '' }, 'signature');
  await prob({ typed: '', drawn: Buffer.from('GIF89a not a png at all').toString('base64') }, 'drawn');
  await prob({ options: ['l1'] }, 'options');
  const tampered = await accept(client(a), live, { totalCents: 100 });
  expect(tampered.status === 409 && tampered.json.error === 'total' && tampered.json.totalCents === totalOf(), `a tampered total answered ${tampered.status} ${tampered.text}`);
  expect(q(`select count(*) from public.texc_acceptances where proposal_id = '${live.id}'`) === '0', 'a refused acceptance wrote something');

  // 3. Twenty at once: exactly one acceptance; the rest get it back.
  const mailBefore = a.outbox().length;
  const opts = DEMO.quote.lines.filter((l) => l.optional).map((l) => l.id);
  const race = await Promise.all(Array.from({ length: 20 }, () => accept(client(a), live, { options: opts, totalCents: totalOf(opts) })));
  const won = race.filter((r) => r.status === 200 && r.json.accepted === true);
  const again = race.filter((r) => r.status === 200 && r.json.already === true);
  expect(won.length === 1 && again.length === 19 && again.every((r) => r.json.acceptance && r.json.acceptance.id === won[0].json.acceptance.id),
    `20 simultaneous acceptances: ${won.length} won, ${again.length} told who won (${race.map((r) => r.status).join(',')})`);
  const row = JSON.parse(q(`select row_to_json(x)::text from (select id, kind, name, options, accepted_total_cents, signature_kind, plaintext_sha256, record_path, record_sha256 from public.texc_acceptances where proposal_id = '${live.id}') x`) || 'null');
  expect(row && row.kind === 'client' && row.signature_kind === 'typed' && row.accepted_total_cents === totalOf(opts) && JSON.stringify(row.options) === JSON.stringify(opts) && row.plaintext_sha256 === lf.sha,
    `the acceptance row is not what was accepted: ${JSON.stringify(row)}`);
  const st1 = await anon.call('POST', '/api/accept', { slug: live.slug, t: live.t, vt: lf.vt, action: 'status' });
  expect(st1.json.accepted && st1.json.accepted.name === person.name && st1.json.open === false, `status after acceptance: ${st1.text}`);
  const sent = a.outbox().slice(mailBefore);
  const office = sent.filter((m) => m.to.includes('office@example.com') && /^Accepted:/.test(m.subject));
  const mine = sent.filter((m) => m.to.includes(person.email));
  expect(office.length === 1 && mine.length === 1, `emails after acceptance: ${office.length} to the office, ${mine.length} to the person (expected one each)`);
  expect(mine[0] && /Next: HP2 — Site preparation/.test(mine[0].text) && /does not constitute unconditional authority/.test(mine[0].text), 'the acceptance email does not carry the HP1 framing and the next hold point, as the revision words them');

  // 4. The stored record: staff only, fingerprint checked, its own strict policy.
  const recNoSession = await anon.call('GET', `/staff/acceptance/${row.id}`);
  expect(recNoSession.status === 302 && /^\/signin\?next=%2Fstaff%2Facceptance%2F/.test(recNoSession.headers.get('location') || ''), `the record without a session answered ${recNoSession.status} ${recNoSession.headers.get('location')}`);
  const rec = await staff.call('GET', `/staff/acceptance/${row.id}`);
  const { RECORD_CSP } = await import('../../lib/acceptance-record.js');
  expect(rec.status === 200 && rec.headers.get('content-security-policy') === RECORD_CSP && sha256(Buffer.from(rec.text, 'utf8')) === row.record_sha256
    && rec.text.includes(person.name) && rec.text.includes(lf.sha) && !/<script/i.test(rec.text), `the record page: ${rec.status}, policy ${rec.headers.get('content-security-policy') === RECORD_CSP}`);
  const sum = (await staff.call('GET', `/api/proposals?id=${live.id}`)).json;
  expect(sum.acceptances && sum.acceptances.length === 1 && sum.acceptances[0].current && sum.acceptances[0].rev === 'A', `the staff summary does not show the acceptance: ${JSON.stringify(sum.acceptances)}`);

  // 5. A new revision after acceptance: the old one stays accepted and can no longer be accepted; the new one must be.
  const dr = (await staff.call('GET', `/api/drafts?id=${live.id}`)).json;
  dr.config.meta.project = `${dr.config.meta.project} (revised)`;
  let put = await staff.call('PUT', '/api/drafts', { id: live.id, version: dr.version, config: dr.config });
  const unacked = await staff.call('POST', '/api/proposals', { action: 'publish', id: live.id, version: put.json.version });
  expect(unacked.status === 422 && JSON.stringify(unacked.json).includes('reaccept:A'), `publishing over an accepted revision without acknowledging it answered ${unacked.status}`);
  put = await staff.call('PUT', '/api/drafts', { id: live.id, version: put.json.version, config: { ...dr.config, acks: [...(dr.config.acks || []), 'reaccept:A'] } });
  const pubB = await staff.call('POST', '/api/proposals', { action: 'publish', id: live.id, version: put.json.version });
  const fb = facts(live, 'B');
  const stB = await anon.call('POST', '/api/accept', { slug: live.slug, t: live.t, vt: fb.vt, action: 'status' });
  const stA = await anon.call('POST', '/api/accept', { slug: live.slug, t: live.t, vt: lf.vt, rev: 'A', action: 'status' });
  expect(pubB.status === 200 && stB.json.open === true && stB.json.earlier && stB.json.earlier.rev === 'A' && stA.json.accepted && stA.json.open === false,
    `after Rev B: B ${stB.text}, A ${stA.text}`);
  const onA = await accept(client(a), live, { rev: 'A' }, lf);
  const onAasCurrent = await accept(client(a), live, {}, lf);
  expect(onA.status === 410 && onAasCurrent.status === 410, `accepting the superseded revision answered ${onA.status} / ${onAasCurrent.status}`);
  const drawn = pngOf(600, 180);
  const onB = await accept(client(a), live, { typed: '', drawn: drawn.toString('base64') }, fb);
  const rowB = JSON.parse(q(`select row_to_json(x)::text from (select signature_kind, signature_path from public.texc_acceptances a join public.texc_proposal_revisions r on r.id = a.revision_id where r.proposal_id = '${live.id}' and r.rev_label = 'B') x`) || 'null');
  expect(onB.status === 200 && onB.json.accepted && rowB && rowB.signature_kind === 'drawn' && /-signature\.png$/.test(rowB.signature_path || ''), `a drawn signature on Rev B: ${onB.status} ${JSON.stringify(rowB)}`);

  // 6. A proposal that allows only a typed signature refuses a drawn one.
  const typedOnly = await demoProposal(staff, { mutate: (c) => { c.accept = { signature: 'typed' }; } });
  const r6 = await accept(client(a), typedOnly, { drawn: drawn.toString('base64') });
  expect(r6.status === 422 && r6.json.fields.includes('drawn'), `a drawn signature where only typed is allowed answered ${r6.status} ${r6.text}`);

  // 7. Withdrawn: refused like any dead link.
  const wd = await demoProposal(staff);
  await staff.call('POST', '/api/proposals', { action: 'withdraw', id: wd.id, note: 'check' });
  const r7 = await accept(client(a), wd);
  expect(r7.status === 410 && r7.text === goneBody, `accepting a withdrawn proposal answered ${r7.status}`);

  // 8. Recorded by staff: administrators only, with a note; once; audited; its record says so.
  const rec8 = await demoProposal(staff);
  const edEmail = 'editor.accept@example.com';
  await anon.call('POST', '/api/auth?action=code', { email: edEmail });
  await staff.call('POST', '/api/people', { email: edEmail, status: 'active', role: 'editor' });
  const ed = client(a);
  await ed.signIn(edEmail);
  const byEditor = await ed.call('POST', '/api/proposals', { action: 'record-acceptance', id: rec8.id, name: 'Sam Whitlock', note: 'Signed PDF returned by email.' });
  const noNote = await staff.call('POST', '/api/proposals', { action: 'record-acceptance', id: rec8.id, name: 'Sam Whitlock', note: 'ok' });
  const byAdmin = await staff.call('POST', '/api/proposals', { action: 'record-acceptance', id: rec8.id, name: 'Sam Whitlock', position: 'Project Manager', note: 'Signed PDF of Rev A returned by email on 14 October.' });
  const twice = await staff.call('POST', '/api/proposals', { action: 'record-acceptance', id: rec8.id, name: 'Sam Whitlock', note: 'Signed PDF returned by email again.' });
  const audit8 = q(`select count(*) from public.texc_staff_audit where proposal_id = '${rec8.id}' and action = 'acceptance_recorded'`);
  const page8 = byAdmin.status === 200 ? await staff.call('GET', `/staff/acceptance/${byAdmin.json.id}`) : null;
  expect(byEditor.status === 403 && noNote.status === 400 && byAdmin.status === 200 && twice.status === 409 && audit8 === '1' && page8 && /Recorded by staff/.test(page8.text),
    `staff-recorded acceptance: editor ${byEditor.status}, no note ${noNote.status}, admin ${byAdmin.status}, again ${twice.status}, audit ${audit8}`);
  const r8 = await accept(client(a), rec8);
  expect(r8.status === 200 && r8.json.already === true && r8.json.acceptance.kind === 'staff', `a client accepting after staff recorded it answered ${r8.status} ${r8.text.slice(0, 100)}`);

  // 9. Requests for changes: logged and sent; nothing is claimed.
  const ch = await demoProposal(staff);
  const cf = facts(ch);
  const mail9 = a.outbox().length;
  const asked = await client(a).call('POST', '/api/changes', { slug: ch.slug, t: ch.t, vt: cf.vt, name: person.name, email: person.email, message: 'Could the start move to the week of 2 November?\nAlso please add a second shotfirer for the first week.' });
  const badAsk = await client(a).call('POST', '/api/changes', { slug: ch.slug, t: ch.t, vt: cf.vt, name: person.name, email: person.email, message: '' });
  const goneAsk = await client(a).call('POST', '/api/changes', { slug: ch.slug, t: ch.t, vt: zero, name: person.name, email: person.email, message: 'Hello there' });
  const logged = q(`select meta->>'message' from public.texc_events where proposal_id = '${ch.id}' and event = 'changes_requested'`);
  const officeAsk = a.outbox().slice(mail9).filter((m) => /^Changes requested:/.test(m.subject));
  expect(asked.status === 200 && badAsk.status === 422 && goneAsk.status === 410 && /second shotfirer/.test(logged) && officeAsk.length === 1
    && q(`select count(*) from public.texc_acceptances where proposal_id = '${ch.id}'`) === '0', `request changes: ${asked.status}, empty ${badAsk.status}, wrong view token ${goneAsk.status}, logged ${!!logged}, emailed ${officeAsk.length}`);

  return fails.length ? { status: FAIL, detail: fails } : { status: PASS, detail: [
    'every bad link, wrong view token or wrong fingerprint gets the uniform 410; form problems name their fields; a tampered total is refused and nothing is written',
    '20 simultaneous acceptances: exactly one written, 19 told who accepted; the office and the person are emailed once, with the revision\'s own HP1 framing and HP2',
    'the stored record is staff-only, matches its fingerprint and runs under its own strict policy',
    'publishing over an accepted revision needs acknowledging; after Rev B the accepted Rev A stays accepted and cannot be accepted again; Rev B accepts with a drawn signature; typed-only proposals refuse a drawn one; withdrawn ones refuse all',
    'staff-recorded acceptance: administrators only, with a note, once, audited, and a client then gets it back; requests for changes are logged and sent, claiming nothing',
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
  // The plan's target: a phone opens a proposal in under a second (docs/architecture.md §13).
  expect(unlockMs < 1500, `unlocking took ${unlockMs} ms at 390 (target under 1 s)`);
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

  // Acceptance on the phone: the form asks for what is missing; then an optional
  // item, a drawn signature, accepted; the quotation locks to what was accepted.
  await cp.evaluate(() => document.getElementById('accept').scrollIntoView());
  await cp.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /\/assets\/js\/signature\.js$/.test(e.name)), null, { timeout: 10000 });
  await cp.waitForTimeout(300);
  await cp.click('[data-accept-go]');
  const firstTry = await cp.evaluate(() => ({ note: document.querySelector('[data-accept-note]').textContent, marked: document.querySelectorAll('[data-accept-form] [aria-invalid="true"], [data-accept-form] [data-invalid="true"]').length }));
  expect(/marked|Sign/.test(firstTry.note) && firstTry.marked >= 2, `an incomplete acceptance did not say what was missing (${JSON.stringify(firstTry)})`);
  const prefilled = await cp.inputValue('[data-accept-form] [name="name"]');
  expect(prefilled === 'Sam Whitlock', `the name was not prefilled from the proposal (${prefilled})`);
  await cp.check('#quote [data-option="o1"]');
  await cp.evaluate(() => document.getElementById('accept').scrollIntoView());
  await cp.fill('[data-accept-form] [name="email"]', 'sam.whitlock@example.com');
  await cp.check('[data-accept-form] [name="authority"]');
  await cp.check('[data-accept-form] [name="accept"]');
  const pad = await cp.$eval('[data-sig-canvas]', (c) => { c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await cp.mouse.move(pad.x + pad.w * 0.15, pad.y + pad.h * 0.6);
  await cp.mouse.down();
  for (let i = 1; i <= 24; i += 1) await cp.mouse.move(pad.x + pad.w * (0.15 + i * 0.028), pad.y + pad.h * (0.6 - 0.25 * Math.sin(i / 3)));
  await cp.mouse.up();
  await cp.click('[data-accept-go]');
  await cp.waitForSelector('[data-accept-done]:not([hidden])', { timeout: 20000 });
  const done = await cp.evaluate(() => ({ by: document.querySelector('[data-done-by]').textContent, total: document.querySelector('[data-done-total]').textContent,
    locked: document.querySelector('#quote [data-option="o1"]').disabled && document.querySelector('#quote [data-option="o1"]').checked, form: document.querySelector('[data-accept-form]').hidden }));
  const { psql: sql } = await import('./local-supabase.mjs');
  const row = JSON.parse(sql(a.sb.conn, `select row_to_json(x)::text from (select signature_kind, options, accepted_total_cents from public.texc_acceptances where proposal_id = '${id}') x`) || 'null');
  expect(done.by === 'Sam Whitlock, Project Manager, Ashgrove Civil Pty Ltd' && done.locked && done.form && row && row.signature_kind === 'drawn' && JSON.stringify(row.options) === '["o1"]',
    `accepting on the phone: ${JSON.stringify(done)} ${JSON.stringify(row)}`);
  await cp.goto(link);
  await cp.fill('#gate-pass', pass);
  await cp.click('#gate-go');
  await cp.waitForSelector('[data-accept-done]:not([hidden])', { timeout: 15000 });
  expect(await cp.evaluate(() => document.querySelector('[data-accept-form]').hidden && document.querySelector('#quote [data-option="o1"]').disabled), 'reopening an accepted proposal did not show it as accepted');

  const fp = await cp.evaluate(() => window.proposalFingerprint());
  expect(/^[a-f0-9]{64}$/.test(fp), 'the plaintext fingerprint was not kept for acceptance');
  await page.waitForTimeout(400);
  const summary = await page.evaluate(async (pid) => (await fetch(`/api/proposals?id=${pid}`)).json(), id);
  // Opened twice (before and after accepting); the office is told about the first open only.
  expect(summary.openCount === 2 && a.outbox().filter((m) => m.subject.startsWith('Opened:') && m.text.includes(summary.reference)).length === 1, `the opens were not counted, or the office not told exactly once (${summary.openCount})`);

  // Revise: same link, Rev B; Rev A still opens, marked superseded.
  const why = async (what) => { const seen = await page.evaluate(() => ({ saved: document.getElementById('ed-saved').textContent, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.textContent.slice(0, 300)) })); return new Error(`${what}: ${JSON.stringify(seen)}`); };
  await page.fill('[data-path="meta.project"] input', 'Proposed specialist controlled rock removal, Stage 2');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('ed-saved').textContent), null, { timeout: 10000 }).catch(async () => { throw await why('the revision did not save'); });
  await page.click('#ed-check');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog .ed-ck')].some((s) => /Changes since/.test(s.textContent) && /Cover/.test(s.textContent)), null, { timeout: 10000 }).catch(async () => { throw await why('the checklist did not list the change'); });
  await page.fill('#ck-note', 'Stage 2 named in the title');
  // Rev A was accepted: publishing Rev B says so and needs acknowledging first.
  const reacc = await page.$$eval('dialog .ed-ack', (n) => n.map((x) => x.textContent).filter((t) => /was accepted by/.test(t)));
  expect(reacc.length === 1 && await page.isDisabled('#ck-publish'), `publishing over the accepted Rev A was not held for an acknowledgement (${reacc.length})`);
  for (const box of await page.$$('dialog .ed-ack input')) await box.check();
  await page.click('#ck-publish');
  await page.waitForSelector('dialog h2:has-text("Rev B")', { timeout: 30000 });
  expect(!(await page.$$eval('dialog .ed-secret code', (c) => c.map((x) => x.textContent))).includes(pass), 'a later revision showed the passphrase again (it should only on first issue)');
  await page.click('dialog .ed-dialog-head button');
  await cp.goto(link);
  await cp.fill('#gate-pass', pass);
  await cp.click('#gate-go');
  await cp.waitForFunction(() => document.documentElement.classList.contains('unlocked'), null, { timeout: 15000 });
  expect((await cp.textContent('[data-field="meta.revLabel"]')).includes('B') && /Stage 2/.test(await cp.textContent('.cover-title')), 'the same link did not open Rev B');
  await cp.waitForSelector('[data-accept-banner]:not([hidden])', { timeout: 10000 });
  expect(/Revised after acceptance — re-acceptance required/.test(await cp.textContent('[data-accept-banner]')) && await cp.isVisible('[data-accept-form]')
    && !(await cp.isDisabled('#quote [data-option="o1"]')), 'Rev B did not ask to be accepted again, or kept Rev A\'s locked quotation');
  await cp.click('[data-revision-links] a:has-text("Rev A")');
  await cp.waitForFunction(() => !document.getElementById('superseded').hidden, null, { timeout: 15000 });
  expect(!/Stage 2/.test(await cp.textContent('.cover-title')), 'Rev A did not show its own content');
  await cp.waitForSelector('[data-accept-done]:not([hidden])', { timeout: 10000 });

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
    'on the phone the client is told what is missing, ticks an optional item, draws a signature and accepts; the quotation locks to what was accepted, and stays so on reopening',
    'the open is recorded and the office told; Rev B needs the acceptance of Rev A acknowledged, then asks the client to accept again; Rev A opens superseded and still accepted',
    'rotation kills the old link at once; an access request reaches admins, is approved, and the person is emailed',
  ] };
}

/* ------------------------------------------------------------ dashboard */

/**
 * The archive and dashboard (Phase 6), on a year of fictional proposals
 * (scripts/demo/dashboard-seed.mjs) plus live ones made through the API:
 * who may see and do what, search, the CSV export, archive and restore end
 * to end (the client link included), practice proposals, and the page itself
 * in a browser at 1440 and 390.
 */
export async function suiteDashboard() {
  const a = await app();
  if (!a) return skipNoStack();
  const fails = [];
  const notes = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const { psql } = await import('./local-supabase.mjs');
  const q = (sql) => psql(a.sb.conn, sql);
  const staff = await checkStaff(a);
  const { seedDashboard } = await import('../demo/dashboard-seed.mjs');
  const LC = await import('../../assets/js/lifecycle.js');
  const seeded = seedDashboard(a.sb.conn);
  const goneBody = '{"error":"gone"}';
  const tag = randomBytes(3).toString('hex');

  // 1. Who may see and do what.
  const anon = client(a);
  const page = await anon.call('GET', '/dashboard');
  expect(page.status === 302 && page.headers.get('location') === '/signin?next=%2Fdashboard', `/dashboard without a session answered ${page.status} ${page.headers.get('location')}`);
  expect((await anon.call('GET', '/api/analytics')).status === 401, 'the dashboard data answered without a session');
  const viewerEmail = `dash-viewer-${tag}@example.com`;
  const editorEmail = `dash-editor-${tag}@example.com`;
  // As in life: each asks for access first, then an administrator approves them.
  await anon.call('POST', '/api/auth?action=code', { email: viewerEmail });
  await anon.call('POST', '/api/auth?action=code', { email: editorEmail });
  await staff.call('POST', '/api/people', { email: viewerEmail, status: 'active', role: 'viewer' });
  await staff.call('POST', '/api/people', { email: editorEmail, status: 'active', role: 'editor' });
  // Its own administrator: in a full run the shared check account has already
  // spent the real per-person publishing and creating limits.
  const adminEmail = `dash-admin-${tag}@example.com`;
  await anon.call('POST', '/api/auth?action=code', { email: adminEmail });
  await staff.call('POST', '/api/people', { email: adminEmail, status: 'active', role: 'admin' });
  const admin = client(a);
  await admin.signIn(adminEmail);
  const viewer = client(a);
  await viewer.signIn(viewerEmail);
  const editor = client(a);
  await editor.signIn(editorEmail);
  const vPage = await viewer.call('GET', '/dashboard');
  const csp = vPage.headers.get('content-security-policy') || '';
  expect(vPage.status === 200 && /<title>Dashboard/.test(vPage.text) && /script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp) && /frame-ancestors 'none'/.test(csp),
    `a viewer opening the dashboard: ${vPage.status}, CSP ${csp.slice(0, 60)}`);
  const vData = await viewer.call('GET', '/api/analytics');
  const rows = (vData.json && vData.json.rows) || [];
  const leaked = rows.flatMap((r) => ['access_token', 'passphrase_enc', 'published_text', 'enc', 'slug', 'search'].filter((k) => k in r));
  expect(vData.status === 200 && rows.length >= seeded.count && !leaked.length, `the dashboard data: ${vData.status}, ${rows.length} rows, leaked ${[...new Set(leaked)].join(' ')}`);
  const vDetail = await viewer.call('GET', `/api/analytics?id=${seeded.ids.latrobe}`);
  const sDetail = await admin.call('GET', `/api/analytics?id=${seeded.ids.latrobe}`);
  expect(vDetail.status === 200 && vDetail.json.proposal.url === null && sDetail.json.proposal.url && vDetail.json.views.length === 4
    && vDetail.json.events.some((e) => e.event === 'changes_requested' && /eastern batter/.test(e.meta.message)), 'one proposal\'s history: a viewer sees it all except the client link');
  const vExport = await viewer.call('GET', '/api/export');
  const vArchive = await viewer.call('POST', '/api/proposals', { action: 'archive', id: seeded.ids.wilmot, reason: 'Not ours to file' });
  const ePractice = await editor.call('POST', '/api/proposals', { action: 'practice', id: seeded.ids.wilmot, on: true });
  expect(vExport.status === 403 && vArchive.status === 403 && ePractice.status === 403, `a viewer exporting ${vExport.status}, a viewer archiving ${vArchive.status}, an editor marking practice ${ePractice.status}`);

  // 2. Search: prefixes of any words, in any order; references by any part.
  const find = async (text) => ((await viewer.call('GET', `/api/analytics?q=${encodeURIComponent(text)}`)).json || {}).ids || [];
  const ref = q(`select reference from public.texc_proposals where id = '${seeded.ids.latrobe}'`);
  expect((await find('petrak granite')).includes(seeded.ids.bicheno) && (await find('Shot Sleeping')).includes(seeded.ids.fingal) && (await find(ref)).includes(seeded.ids.latrobe)
    && !(await find('petrak zzzz')).length && (await find("') or 1=1 --")).length === 0, 'search by contact, service name and reference; every word must match; quotes are only words');

  // 3. The CSV export: the list as filtered, formula-safe, recorded.
  const audits = () => Number(q(`select count(*) from public.texc_staff_audit where action = 'exported'`));
  const before = audits();
  // Read as bytes: a text decoder would quietly drop the byte-order mark being checked for.
  const raw = await fetch(`${a.url}/api/export?state=accepted&region=North-West%20Tasmania`, { headers: { cookie: editor.cookie(), origin: a.url } });
  const bytes = Buffer.from(await raw.arrayBuffer());
  const csv = { status: raw.status, headers: raw.headers, text: bytes.toString('utf8') };
  expect(csv.status === 200 && /^text\/csv/.test(csv.headers.get('content-type') || '') && /attachment; filename=".+-proposals-\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers.get('content-disposition') || '')
    && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && /Highway cutting widening/.test(csv.text) && !/Boat ramp approach/.test(csv.text) && audits() === before + 1,
    `export: ${csv.status} ${csv.headers.get('content-type')} ${csv.headers.get('content-disposition')}, audited ${audits() - before}`);
  const crossSite = await editor.call('GET', '/api/export', undefined, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  expect(crossSite.status === 403 && audits() === before + 1, `an export asked for by another site answered ${crossSite.status}`);
  const hostile = await admin.call('POST', '/api/proposals', { action: 'create', config: { meta: { project: `Formula check ${tag}` }, client: { company: '=HYPERLINK("http://evil.example","Open")' } } });
  const draftCsv = await admin.call('GET', `/api/export?state=draft&q=${encodeURIComponent(`formula check ${tag}`)}`);
  expect(hostile.status === 200 && /"'=HYPERLINK\(""http:\/\/evil\.example"",""Open""\)"/.test(draftCsv.text) && draftCsv.text.split('\r\n').length === 3,
    `a formula-shaped client name was not defused in the export: ${draftCsv.text.split('\r\n')[1]}`);

  // 4. Archive and restore, end to end, on a live proposal.
  const live = await demoProposal(admin);
  const open = () => client(a).call('GET', `/api/proposal?slug=${live.slug}&t=${live.t}`);
  expect((await open()).status === 200, 'the live proposal did not open before archiving');
  const noWhy = await editor.call('POST', '/api/proposals', { action: 'archive', id: live.id, reason: '' });
  const arch = await editor.call('POST', '/api/proposals', { action: 'archive', id: live.id, reason: 'Awarded to another contractor' });
  const whileArchived = await open();
  const draft = await editor.call('GET', `/api/drafts?id=${live.id}`);
  const save = await editor.call('PUT', '/api/drafts', { id: live.id, version: draft.json.version, config: draft.json.config });
  const pub = await admin.call('POST', '/api/proposals', { action: 'publish', id: live.id, version: draft.json.version });
  const listed = ((await editor.call('GET', '/api/proposals')).json.proposals || []).some((p) => p.id === live.id);
  const archRow = ((await editor.call('GET', '/api/analytics')).json.rows || []).find((r) => r.id === live.id);
  expect(noWhy.status === 400 && arch.status === 200 && arch.json.changed === true, `archiving: without a reason ${noWhy.status}, with one ${arch.status}`);
  expect(whileArchived.status === 410 && whileArchived.text === goneBody, `the client link while archived answered ${whileArchived.status} ${whileArchived.text.slice(0, 60)}`);
  expect(draft.status === 200 && draft.json.proposal.archivedAt && save.status === 409 && save.json.error === 'archived' && pub.status === 409, `while archived: open ${draft.status}, save ${save.status}, publish ${pub.status}`);
  expect(!listed && archRow && LC.stateOf(archRow, new Date()) === 'archived' && archRow.status === 'issued', 'archived: out of the editor\'s list, archived on the dashboard, still issued (not withdrawn)');
  const restored = await editor.call('POST', '/api/proposals', { action: 'restore', id: live.id });
  const again = await editor.call('POST', '/api/proposals', { action: 'restore', id: live.id });
  const afterRestore = await open();
  const trail = q(`select string_agg(event, ',' order by id) from public.texc_events where proposal_id = '${live.id}' and event in ('archived', 'restored')`);
  const audited = q(`select string_agg(action, ',' order by id) from public.texc_staff_audit where proposal_id = '${live.id}' and action in ('archived', 'restored')`);
  expect(restored.status === 200 && restored.json.changed === true && again.json.changed === false && afterRestore.status === 200 && trail === 'archived,restored' && audited === 'archived,restored',
    `restoring: ${restored.status}, again changed=${again.json && again.json.changed}, link ${afterRestore.status}, events ${trail}, audit ${audited}`);

  // 5. Practice proposals leave every figure; drafts keep their listing current.
  const practice = await admin.call('POST', '/api/proposals', { action: 'practice', id: seeded.ids.ridgeway, on: true });
  const rows2 = (await admin.call('GET', '/api/analytics')).json.rows;
  const afterFig = LC.figures(rows2, 'all', new Date());
  const beforeFig = LC.figures(rows2.map((r) => (r.id === seeded.ids.ridgeway ? { ...r, is_test: false } : r)), 'all', new Date());
  expect(practice.status === 200 && afterFig.issued === beforeFig.issued - 1 && afterFig.accepted === beforeFig.accepted - 1
    && q(`select count(*) from public.texc_events where proposal_id = '${seeded.ids.ridgeway}' and event = 'marked_practice'`) === '1', `practice: ${practice.status}, issued ${beforeFig.issued}→${afterFig.issued}`);
  await admin.call('POST', '/api/proposals', { action: 'practice', id: seeded.ids.ridgeway, on: false });
  const fresh = await admin.call('POST', '/api/proposals', { action: 'create', config: { meta: { project: `Listing check ${tag}` } } });
  const fd = await admin.call('GET', `/api/drafts?id=${fresh.json.id}`);
  await admin.call('PUT', '/api/drafts', { id: fresh.json.id, version: fd.json.version, config: { ...fd.json.config, client: { company: `Ridgeline Listing ${tag} Pty Ltd`, contactName: 'Morgan Ashby' }, meta: { project: `Listing check ${tag}`, siteLocality: 'Scottsdale', siteRegion: 'Northern Tasmania' } } });
  const listing = q(`select client_company || '|' || site_locality from public.texc_proposals where id = '${fresh.json.id}'`);
  expect(listing === `Ridgeline Listing ${tag} Pty Ltd|Scottsdale` && (await find(`morgan ridgeline ${tag}`)).includes(fresh.json.id), `a draft's listing after a save: ${listing}`);

  // 6. Deleting for good: Brand in Black only, 90 days after archiving, never accepted, files and all.
  const stored = async (bucket, folder) => {
    const r = await fetch(`${a.sb.url}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { apikey: a.sb.secretKey, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: folder, limit: 100 }) });
    return r.ok ? (await r.json()).length : -1;
  };
  const doomed = await demoProposal(admin);
  const dref = q(`select reference from public.texc_proposals where id = '${doomed.id}'`);
  const purgeAs = (c, id, confirm) => c.call('POST', '/api/proposals', { action: 'purge', id, confirm });
  const notArchived = await purgeAs(staff, doomed.id, dref);
  await admin.call('POST', '/api/proposals', { action: 'archive', id: doomed.id, reason: 'Duplicate or sent in error' });
  const tooSoon = await purgeAs(staff, doomed.id, dref);
  q(`update public.texc_proposals set archived_at = now() - interval '91 days' where id = '${doomed.id}'`);
  const byAdmin = await purgeAs(admin, doomed.id, dref);
  const wrongWord = await purgeAs(staff, doomed.id, dref.toLowerCase());
  const filesBefore = await stored('texc-attachments', `proposals/${doomed.id}/attachments`);
  expect(notArchived.status === 409 && tooSoon.status === 409 && /can be deleted from/.test(tooSoon.json.error) && byAdmin.status === 403 && wrongWord.status === 400 && filesBefore > 0,
    `purge refusals: not archived ${notArchived.status}, too soon ${tooSoon.status}, an administrator ${byAdmin.status}, wrong word ${wrongWord.status}, files before ${filesBefore}`);
  q(`update public.texc_proposals set archived_at = now() - interval '120 days' where id = '${seeded.ids.ridgeway}'`);
  const keptRef = q(`select reference from public.texc_proposals where id = '${seeded.ids.ridgeway}'`);
  const kept = await purgeAs(staff, seeded.ids.ridgeway, keptRef);
  expect(kept.status === 409 && /business record/.test(kept.json.error), `an accepted proposal answered a purge with ${kept.status} ${kept.text.slice(0, 80)}`);
  const swept = await purgeAs(staff, doomed.id, dref);
  const remaining = q(`select (select count(*) from public.texc_proposals where id = '${doomed.id}') + (select count(*) from public.texc_events where proposal_id = '${doomed.id}') + (select count(*) from public.texc_proposal_revisions where proposal_id = '${doomed.id}') + (select count(*) from public.texc_attachments where proposal_id = '${doomed.id}')`);
  const note = q(`select detail->>'reference' || '|' || coalesce(detail->>'archive_reason', '') from public.texc_staff_audit where proposal_id = '${doomed.id}' and action = 'proposal_purged'`);
  const linkAfter = await client(a).call('GET', `/api/proposal?slug=${doomed.slug}&t=${doomed.t}`);
  expect(swept.status === 200 && swept.json.removed.revisions === 1 && swept.json.removed.stored >= filesBefore && remaining === '0'
    && (await stored('texc-attachments', `proposals/${doomed.id}/attachments`)) === 0 && note === `${dref}|Duplicate or sent in error` && linkAfter.status === 410 && linkAfter.text === goneBody,
    `purge: ${swept.status} ${swept.text.slice(0, 120)}, rows left ${remaining}, audit note ${note}, link ${linkAfter.status}`);

  // 7. The page, in a browser.
  const b = await browser();
  if (!b) notes.push('NOT CHECKED in a browser: Playwright not found');
  else {
    const vctx = await b.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const vp = await vctx.newPage();
    const vproblems = [];
    vp.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) vproblems.push(m.text().slice(0, 160)); });
    vp.on('pageerror', (e) => vproblems.push('script error: ' + e.message));
    await vp.goto(`${a.url}/signin`);
    await vp.fill('#email', viewerEmail);
    await vp.click('#email-form button');
    await vp.waitForSelector('[data-step="code"]:not([hidden])');
    await vp.fill('#code', a.codeFor(a.outbox(), viewerEmail));
    await vp.click('#code-form button');
    await vp.waitForURL((u) => new URL(u).pathname === '/dashboard', { timeout: 15000 }).catch(() => {});
    expect(new URL(vp.url()).pathname === '/dashboard', `signing in with nowhere else to go landed on ${vp.url()}`);
    await vp.waitForSelector('.db-svg', { timeout: 15000 }).catch(() => {});
    const phone = await vp.evaluate(() => ({
      wide: document.documentElement.scrollWidth, tiles: document.querySelectorAll('.db-tile').length, cols: document.querySelectorAll('.db-col').length,
      editorBits: [...document.querySelectorAll('[data-role]')].filter((e) => !e.hidden && e.getClientRects().length).length,
    }));
    expect(phone.wide <= 390 && phone.tiles === 5 && phone.cols === 12 && phone.editorBits === 0, `the viewer's dashboard at 390: ${JSON.stringify(phone)}`);
    expect(!vproblems.length, `the viewer's page reported: ${vproblems.join(' | ')}`);
    await vctx.close();

    const { ctx, page: p, problems } = await signedInContext(a, b);
    await p.goto(`${a.url}/dashboard?open=${seeded.ids.latrobe}`);
    await p.waitForSelector('.db-timeline');
    const panel = await p.evaluate(() => document.querySelector('#db-panel').innerText);
    expect(/Sarah Kemp asked for changes/.test(panel) && /Accepted revision B online/.test(panel) && /Opened revision A/.test(panel), 'the history panel tells the proposal\'s story');
    const stray = await p.evaluate(() => document.body.innerText + document.querySelector('#db-panel').innerText);
    expect(!/\b(null|undefined|NaN)\b/.test(stray), `the page shows a programming placeholder: ${(/.{0,40}\b(null|undefined|NaN)\b.{0,20}/.exec(stray) || [''])[0]}`);
    await p.click('#db-panel .db-close');
    await p.focus('.db-col:last-of-type');
    const tip = await p.evaluate(() => { const t = document.querySelector('.db-tip'); return t && !t.hidden ? t.innerText : ''; });
    expect(/Issued\s+\d+/.test(tip) && /Accepted\s+\d+/.test(tip), `focusing a month did not show its figures: ${tip}`);
    await p.click('#db-chart-table-btn');
    expect(await p.evaluate(() => document.querySelectorAll('#db-chart-table tbody tr').length) === 12, 'the chart\'s table view does not list 12 months');
    await p.fill('#f-q', 'petrakis');
    await p.waitForFunction(() => document.querySelectorAll('#db-rows tr').length === 1, null, { timeout: 5000 }).catch(() => {});
    expect(await p.evaluate(() => document.querySelector('#db-rows').innerText.includes('House footings in granite')), 'search did not narrow the list to one proposal');
    expect(/q=petrakis/.test(p.url()) && /q=petrakis/.test(await p.getAttribute('#db-export', 'href')), 'the search is not kept in the address and the export link');
    await p.fill('#f-q', '');
    await p.selectOption('#f-state', 'followup');
    await p.waitForTimeout(400);
    const flagged = await p.evaluate(() => [...document.querySelectorAll('#db-rows tr')].map((r) => !!r.querySelector('.db-flag')));
    expect(flagged.length >= 3 && flagged.every(Boolean), `"Needs a follow-up" listed ${flagged.length} rows, some without a reason`);
    await p.selectOption('#f-state', '');
    // Archive and restore through the page.
    const other = await demoProposal(admin);
    await p.goto(`${a.url}/dashboard?open=${other.id}`);
    await p.waitForSelector('#db-archive');
    await p.click('#db-archive');
    await p.selectOption('#db-ar-reason', 'The client did not go ahead');
    await p.click('.db-archive-form [type=submit]');
    await p.waitForSelector('#db-restore', { timeout: 10000 }).catch(() => {});
    const archivedNote = await p.evaluate(() => (document.querySelector('.db-panel-archived') || {}).innerText || '');
    expect(/Archived .* “The client did not go ahead”/.test(archivedNote) && (await client(a).call('GET', `/api/proposal?slug=${other.slug}&t=${other.t}`)).status === 410, `archiving in the page: ${archivedNote}`);
    await p.click('#db-restore');
    await p.waitForSelector('#db-archive', { timeout: 10000 }).catch(() => {});
    expect((await client(a).call('GET', `/api/proposal?slug=${other.slug}&t=${other.t}`)).status === 200, 'restoring in the page did not bring the link back');
    // Deleting for good through the page, typing the reference.
    await admin.call('POST', '/api/proposals', { action: 'archive', id: other.id, reason: 'Work completed' });
    q(`update public.texc_proposals set archived_at = now() - interval '100 days' where id = '${other.id}'`);
    const oref = q(`select reference from public.texc_proposals where id = '${other.id}'`);
    await p.goto(`${a.url}/dashboard?open=${other.id}`);
    await p.waitForSelector('#db-purge');
    await p.click('#db-purge');
    await p.fill('#db-purge-confirm', oref);
    await p.click('.db-archive-form [type=submit]');
    await p.waitForFunction(() => !document.getElementById('db-panel').open, null, { timeout: 10000 }).catch(() => {});
    const goneRow = q(`select count(*) from public.texc_proposals where id = '${other.id}'`);
    const listed2 = await p.evaluate(() => window.__dashboard.state.rows.length);
    expect(goneRow === '0' && listed2 > 0, `deleting in the page left ${goneRow} rows`);
    expect(!problems.length, `the staff page reported: ${problems.join(' | ')}`);
    await ctx.close();
  }

  if (fails.length) return { status: FAIL, detail: fails };
  return { status: notes.length ? SKIP : PASS, detail: [
    'staff only: no session is sent to sign in; viewers see everything but the client link and cannot export, archive or mark practice; the data carries no token, passphrase or content',
    'search by any words\' beginnings (contact, service, reference), all of them; the CSV is the filtered list, formula-safe, same-site only and recorded',
    'archiving refuses the client link with the uniform 410, takes no saves or publishing, leaves the editor\'s list and is not a withdrawal; restoring brings it all back; both are logged and audited',
    'practice proposals leave every figure; a draft\'s listing follows its saves',
    'deleting for good: Brand in Black only, 90 days after archiving, never once accepted, by typing the reference; the rows and the stored files go, the link answers 410, and the staff audit keeps a note',
    'in the browser: signing in lands on the dashboard; 390 wide with nothing off the edge; months focusable with their figures; a table twin; search and filters kept in the address; history; archive and restore',
    ...notes,
  ] };
}

/* ------------------------------------------------------------ accessibility */

/**
 * axe-core's WCAG 2.2 A and AA rules on every page a person meets, at 1440
 * and 390, under the real CSP (axe is evaluated through the browser's own
 * debugging channel, which a page's policy does not govern): the client page
 * from the demo, the gate, a proposal unlocked down to its acceptance form,
 * a dead link, sign-in, the dashboard and its history panel, the editor.
 */
export async function suiteA11y() {
  const a = await app();
  if (!a) return skipNoStack();
  const { axeSource, axeVersion } = await import('./audit-tools.mjs');
  const axe = axeSource();
  if (!axe) return { status: SKIP, detail: ['axe-core not found (scripts/lib/audit-tools.mjs says how to install it outside the repo)'] };
  const b = await browser();
  if (!b) return { status: SKIP, detail: ['Playwright not found'] };
  const { psql } = await import('./local-supabase.mjs');
  const q = (sql) => psql(a.sb.conn, sql);
  const staff = await checkStaff(a);
  if (q("select count(*) from public.texc_proposals where created_by = 'george@example.com'") === '0') {
    const { seedDashboard } = await import('../demo/dashboard-seed.mjs');
    seedDashboard(a.sb.conn);
  }
  const live = await demoProposal(staff);
  const path = new URL(live.url).pathname + new URL(live.url).search;
  const story = q("select id from public.texc_proposals where created_by = 'george@example.com' and project like 'Highway cutting%' limit 1");
  const { ctx: sctx } = await signedInContext(a, b);
  const signedIn = await sctx.storageState();
  await sctx.close();

  const PAGES = [
    { name: 'client page (demo)', url: '/demo', ready: '[data-sec="cover"]' },
    { name: 'gate', url: path, ready: '#gate-form' },
    { name: 'client page, unlocked', url: path, ready: '#gate-form', unlock: true },
    { name: 'dead link', url: `/p/aaaaaaaaaa?t=${'0'.repeat(64)}`, ready: '[data-gate="gone"]:not([hidden])' },
    { name: 'sign-in', url: '/signin', ready: '#email' },
    { name: 'page not found', url: '/no-such-page', ready: '.gate-title' },
    { name: 'dashboard', url: '/dashboard', ready: '.db-svg', staff: true },
    { name: 'dashboard, history panel', url: `/dashboard?open=${story}`, ready: '.db-timeline', staff: true },
    { name: 'editor', url: `/editor/${live.id}`, ready: '#ed-panels .ed-panel', staff: true },
  ];
  const found = [];
  let checked = 0;
  for (const [width, height, scale] of [[1440, 900, 1], [390, 844, 2]]) {
    for (const pg of PAGES) {
      const ctx = await b.browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', ...(pg.staff ? { storageState: signedIn } : {}) });
      const page = await ctx.newPage();
      try {
        await page.goto(a.url + pg.url);
        await page.waitForSelector(pg.ready, { timeout: 20000 });
        if (pg.unlock) {
          await page.fill('#gate-pass', live.passphrase);
          await page.click('#gate-go');
          await page.waitForFunction(() => document.documentElement.classList.contains('unlocked'), null, { timeout: 20000 });
        }
        await page.waitForTimeout(400);
        await page.evaluate(axe);
        const tags = (process.env.A11Y_TAGS || 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa').split(',');
        const res = await page.evaluate((values) => window.axe.run(document, { runOnly: { type: 'tag', values }, resultTypes: ['violations'] }), tags);
        checked += 1;
        for (const v of res.violations) {
          found.push(`${pg.name} @${width}: ${v.id} (${v.impact}, ${v.nodes.length}×) ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
        }
      } catch (e) {
        found.push(`${pg.name} @${width}: could not be audited (${e.message.split('\n')[0]})`);
      }
      await ctx.close();
    }
  }
  if (found.length) return { status: FAIL, detail: found };
  return { status: PASS, detail: [`axe-core ${axeVersion()}, WCAG 2.2 A and AA: no violations on ${checked} pages and states (${PAGES.map((p) => p.name).join(', ')}) at 1440 and 390`] };
}

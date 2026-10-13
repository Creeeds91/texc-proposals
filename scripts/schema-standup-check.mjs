#!/usr/bin/env node
/**
 * Can supabase/schema.sql stand up a working, locked-down database from
 * nothing — and does it hold the promises the app rests on?
 *
 * Runs the real file against a real empty Postgres (twice: it must be
 * re-runnable), behind the real PostgREST, then:
 *   - attacks it as `anon`, the role a leaked publishable key gets, through the
 *     API and in SQL: no table readable, nothing writable, no function callable;
 *   - drives the publish, rotate, withdraw and view functions as the server
 *     does, including the races (a stale revision number, a changed passphrase);
 *   - tries to change, delete and truncate a published revision and the
 *     append-only logs, and expects every attempt refused.
 *
 *   node scripts/schema-standup-check.mjs        a fresh local stack, deleted afterwards
 *
 * Exit 0 all held · 1 something failed · 2 could not run (no Postgres/Docker).
 * Nothing here touches a hosted database. Exported as runSchemaProof() for
 * `node scripts/check.mjs schema`.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { startLocalSupabase, psql } from './lib/local-supabase.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = resolve(ROOT, 'supabase/schema.sql');

export const TABLES = ['texc_users', 'texc_login_tokens', 'texc_user_sessions', 'texc_proposals', 'texc_proposal_revisions',
  'texc_revision_keys', 'texc_drafts', 'texc_events', 'texc_proposal_views', 'texc_settings', 'texc_counters',
  'texc_rate_limits', 'texc_staff_audit'];
const RPCS = {
  texc_rate_hit: { p_key: 'x', p_max: 1, p_window_seconds: 60 },
  texc_claim_reference: { p_proposal: '00000000-0000-0000-0000-000000000000', p_prefix: 'X' },
  texc_publish: { p: {} }, texc_rotate: { p: {} }, texc_withdraw: { p_proposal: '00000000-0000-0000-0000-000000000000', p_actor: 'x', p_note: '' },
  texc_record_view: { p: {} },
};

const hex = (n) => randomBytes(n).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function runSchemaProof({ log = () => {} } = {}) {
  const results = [];
  const ok = (label, cond, got) => { results.push({ label, ok: !!cond, got }); log(`${cond ? '  ok  ' : '  FAIL'} ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`); };
  const dir = join(tmpdir(), 'texc-schema-proof-' + hex(4));
  let sb;
  try { sb = await startLocalSupabase({ dir, schema: false }); }
  catch (e) { return { ran: false, reason: e.message, results }; }
  if (!sb) return { ran: false, reason: 'Postgres 16 or Docker is not available here', results };
  const q = (sql) => psql(sb.conn, sql);
  try {
    log('Building from nothing');
    let built = true;
    try { psql(sb.conn, SCHEMA, { file: true }); } catch (e) { built = false; log(String(e.stderr || e.message).slice(0, 600)); }
    ok('schema.sql runs against an empty database with no errors', built);
    let again = true;
    try { psql(sb.conn, SCHEMA, { file: true }); } catch (e) { again = false; log(String(e.stderr || e.message).slice(0, 600)); }
    ok('and runs a second time safely (idempotent)', again);
    // PostgREST caches the schema; tell it the tables now exist.
    q("notify pgrst, 'reload schema'");
    await new Promise((d) => setTimeout(d, 600));

    log('Everything the app talks to exists');
    const missing = TABLES.filter((t) => q(`select to_regclass('public.${t}') is null`) === 't');
    ok(`all ${TABLES.length} tables exist`, missing.length === 0, missing);
    const fnsMissing = Object.keys(RPCS).filter((f) => q(`select count(*) from pg_proc where proname = '${f}'`) === '0');
    ok(`all ${Object.keys(RPCS).length} functions exist`, fnsMissing.length === 0, fnsMissing);

    log('Locked down from birth');
    const tables = Number(q("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'"));
    const rls = Number(q("select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity"));
    ok('row-level security is on for every table', rls === tables && tables === TABLES.length, { rls, tables });
    ok('and no policy opens any of them', q("select count(*) from pg_policies where schemaname = 'public'") === '0');
    const grants = q("select string_agg(grantee || ':' || table_name || ':' || privilege_type, ' ') from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')");
    ok('anon and authenticated hold no table privilege at all', !grants, grants);
    const exec = q("select string_agg(p.proname, ' ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'texc_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))");
    ok('no function is executable by anon or authenticated', !exec, exec);
    const definer = q(`select string_agg(proname, ' ') from pg_proc where proname in (${Object.keys(RPCS).map((f) => `'${f}'`).join(',')}) and not prosecdef`);
    ok('every RPC is security definer', !definer, definer);
    const unpinned = q("select string_agg(p.proname, ' ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'texc_%' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')");
    ok('every function pins its search_path', !unpinned, unpinned);

    log('Attacked through the API as a leaked publishable key');
    const anon = { apikey: sb.anonKey, 'content-type': 'application/json' };
    const reads = [];
    for (const t of TABLES) {
      const r = await fetch(`${sb.url}/rest/v1/${t}?select=*&limit=1`, { headers: anon });
      const body = await r.text();
      if (r.ok && body !== '[]') reads.push(`${t}:${r.status}`);
    }
    ok('no table can be read', reads.length === 0, reads);
    const w = await fetch(`${sb.url}/rest/v1/texc_users`, { method: 'POST', headers: anon, body: JSON.stringify({ email: 'evil@example.com', role: 'admin', status: 'active' }) });
    ok('it cannot make itself an admin', !w.ok, w.status);
    const s = await fetch(`${sb.url}/rest/v1/texc_user_sessions`, { method: 'POST', headers: anon, body: JSON.stringify({ token_hash: 'x', email: 'x', expires_at: '2099-01-01' }) });
    ok('it cannot forge a session', !s.ok, s.status);
    const called = [];
    for (const [f, args] of Object.entries(RPCS)) {
      const r = await fetch(`${sb.url}/rest/v1/rpc/${f}`, { method: 'POST', headers: anon, body: JSON.stringify(args) });
      if (r.ok) called.push(f);
    }
    ok('no function can be called', called.length === 0, called);

    log('Attacked in SQL as anon');
    const probe = q(`
      create or replace function pg_temp.probe() returns setof text language plpgsql as $f$
      begin
        set local role anon;
        begin perform count(*) from public.texc_proposal_revisions; return next 'read revisions: GOT IN';
        exception when others then return next 'read revisions: refused'; end;
        begin insert into public.texc_users (email, role, status) values ('evil@example.com', 'admin', 'active'); return next 'insert user: GOT IN';
        exception when others then return next 'insert user: refused'; end;
        begin perform public.texc_rate_hit('x', 1, 60); return next 'call function: GOT IN';
        exception when others then return next 'call function: refused'; end;
      end $f$;
      select * from pg_temp.probe();`);
    ok('anon in SQL is refused reads, writes and calls', !/GOT IN/.test(probe), probe);

    log('The server path: publish, conflicts, supersede');
    const svc = { apikey: sb.secretKey, 'content-type': 'application/json' };
    const rest = async (method, path, body, prefer = 'return=representation') => {
      const r = await fetch(`${sb.url}/rest/v1/${path}`, { method, headers: { ...svc, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, ok: r.ok, json, text };
    };
    const rpc = (f, args) => rest('POST', `rpc/${f}`, args);
    const slug = hex(5);
    const created = await rest('POST', 'texc_proposals', { slug, created_by: 'proof@example.com' });
    ok('a proposal is created through the API', created.ok, created.text);
    const pid = created.json && created.json[0].id;
    await rest('POST', 'texc_drafts', { proposal_id: pid, config: { meta: { project: 'Proof' } }, updated_by: 'proof@example.com' });
    const ref1 = await rpc('texc_claim_reference', { p_proposal: pid, p_prefix: 'PROOF-P' });
    const ref2 = await rpc('texc_claim_reference', { p_proposal: pid, p_prefix: 'PROOF-P' });
    ok('a reference is allocated once and kept', ref1.ok && ref1.json === ref2.json && /^PROOF-P-\d{4}-001$/.test(ref1.json), [ref1.json, ref2.json]);
    const token = hex(32);
    const pass = 'vault:' + hex(8);
    const revision = (index, extra = {}) => ({
      proposal_id: pid, reference: ref1.json, rev_index: index, rev_label: String.fromCharCode(64 + index),
      enc: JSON.stringify({ v: 1, ct: hex(16) }), enc_sha256: sha('e' + index), published_text: '{"p":' + index + '}', plaintext_sha256: sha('p' + index),
      view_token_hash: sha('vt' + index), template_version: 1, quote_snapshot: { lines: [] }, published_by: 'proof@example.com',
      access_token: token, passphrase_enc: pass, link_expires_at: '2099-01-01T00:00:00Z', valid_until: '2099-01-01', value_cents: 100,
      project: 'Proof', services: ['microblasting'],
      key: { kdf: 'PBKDF2-SHA256', iter: 600000, salt: hex(16), iv: hex(12), wrapped: hex(40) },
      ...extra,
    });
    const p1 = await rpc('texc_publish', { p: revision(1) });
    ok('revision A publishes', p1.ok && p1.json.rev_label === 'A', p1.text);
    const stale = await rpc('texc_publish', { p: revision(1) });
    ok('publishing a stale revision number is refused (someone published first)', !stale.ok && /conflict/.test(stale.text), stale.text);
    const wrongPass = await rpc('texc_publish', { p: revision(2, { passphrase_enc: 'vault:other' }) });
    ok('publishing under a different passphrase is refused', !wrongPass.ok && /conflict/.test(wrongPass.text), wrongPass.text);
    const p2 = await rpc('texc_publish', { p: revision(2) });
    ok('revision B publishes', p2.ok && p2.json.rev_label === 'B', p2.text);
    const revs = await rest('GET', `texc_proposal_revisions?proposal_id=eq.${pid}&select=id,rev_label,superseded_at&order=rev_index`);
    const prop = await rest('GET', `texc_proposals?id=eq.${pid}&select=current_revision_id,status,access_token,issued_at`);
    ok('A is superseded, B is current, the proposal is issued', revs.json[0].superseded_at && !revs.json[1].superseded_at
      && prop.json[0].current_revision_id === revs.json[1].id && prop.json[0].status === 'issued', { revs: revs.json, prop: prop.json });
    const draft = await rest('GET', `texc_drafts?proposal_id=eq.${pid}&select=base_revision_id`);
    ok('the draft records which revision it was published as', draft.json[0].base_revision_id === revs.json[1].id, draft.json);

    log('Published revisions cannot change');
    const idA = revs.json[0].id;
    const edit = await rest('PATCH', `texc_proposal_revisions?id=eq.${idA}`, { published_text: 'tampered' });
    ok('changing published text is refused', !edit.ok, edit.status);
    const del = await rest('DELETE', `texc_proposal_revisions?id=eq.${idA}`);
    ok('deleting a revision is refused', !del.ok, del.status);
    const unsup = await rest('PATCH', `texc_proposal_revisions?id=eq.${idA}`, { superseded_at: '2030-01-01T00:00:00Z' });
    ok('superseded_at cannot be moved once set', !unsup.ok, unsup.status);
    let truncated = true;
    try { q('truncate public.texc_proposal_revisions cascade'); } catch { truncated = false; }
    ok('truncating revisions is refused', !truncated);
    const evEdit = await rest('PATCH', `texc_events?proposal_id=eq.${pid}`, { event: 'forged' });
    const evDel = await rest('DELETE', `texc_events?proposal_id=eq.${pid}`);
    ok('events are append-only (no update, no delete)', !evEdit.ok && !evDel.ok, [evEdit.status, evDel.status]);
    const count = () => Number(q(`select count(*) from public.texc_events where proposal_id = '${pid}'`));
    const before = count();
    let purged = false;
    try { q(`begin; set local texc.purge = 'on'; delete from public.texc_events where id = (select min(id) from public.texc_events where proposal_id = '${pid}'); commit;`); purged = true; } catch { purged = false; }
    const afterPurge = count();
    let leaked = true;
    try { q(`delete from public.texc_events where proposal_id = '${pid}'`); } catch { leaked = false; }
    ok('only the transaction-local purge flag lets a deletion through, and only inside that transaction', purged && afterPurge === before - 1 && !leaked && count() === afterPurge, { before, afterPurge, leaked });

    log('Rotation, withdrawal, views, rate limits, drafts');
    const keys = revs.json.map((r) => ({ revision_id: r.id, kdf: 'PBKDF2-SHA256', iter: 600000, salt: hex(16), iv: hex(12), wrapped: hex(40) }));
    const badRotate = await rpc('texc_rotate', { p: { proposal_id: pid, old_passphrase_enc: 'vault:wrong', passphrase_enc: 'vault:new', access_token: hex(32), keys, actor: 'proof' } });
    ok('rotation against the wrong current passphrase is refused', !badRotate.ok, badRotate.text);
    const partRotate = await rpc('texc_rotate', { p: { proposal_id: pid, old_passphrase_enc: pass, passphrase_enc: 'vault:new', access_token: hex(32), keys: keys.slice(0, 1), actor: 'proof' } });
    ok('rotation that leaves a revision un-wrapped is refused', !partRotate.ok, partRotate.text);
    const newToken = hex(32);
    const rot = await rpc('texc_rotate', { p: { proposal_id: pid, old_passphrase_enc: pass, passphrase_enc: 'vault:new', access_token: newToken, keys, actor: 'proof' } });
    const after = await rest('GET', `texc_proposals?id=eq.${pid}&select=access_token,passphrase_enc`);
    const k1 = await rest('GET', `texc_revision_keys?revision_id=eq.${revs.json[0].id}&select=salt`);
    ok('rotation swaps the link and passphrase and re-wraps every key', rot.ok && after.json[0].access_token === newToken && after.json[0].passphrase_enc === 'vault:new' && k1.json[0].salt === keys[0].salt, rot.text);
    const v1 = await rpc('texc_record_view', { p: { proposal_id: pid, revision_id: revs.json[1].id, session: 's1', device: 'Safari on iOS', region: 'TAS' } });
    const v2 = await rpc('texc_record_view', { p: { proposal_id: pid, revision_id: revs.json[1].id, session: 's2' } });
    const opened = await rest('GET', `texc_proposals?id=eq.${pid}&select=open_count,first_opened_at`);
    ok('the first open is reported once and counted', v1.json.first === true && v2.json.first === false && opened.json[0].open_count === 2 && opened.json[0].first_opened_at, [v1.json, v2.json, opened.json]);
    const wd = await rpc('texc_withdraw', { p_proposal: pid, p_actor: 'proof', p_note: 'sent in error' });
    const wrev = await rest('GET', `texc_proposal_revisions?id=eq.${revs.json[1].id}&select=withdrawn_at`);
    const wprop = await rest('GET', `texc_proposals?id=eq.${pid}&select=status`);
    ok('withdrawal marks the current revision and the proposal', wd.ok && wrev.json[0].withdrawn_at && wprop.json[0].status === 'withdrawn', [wd.text, wrev.json, wprop.json]);
    const hits = [];
    for (let i = 0; i < 4; i += 1) hits.push((await rpc('texc_rate_hit', { p_key: 'proof:' + slug, p_max: 3, p_window_seconds: 60 })).json);
    ok('the rate limit allows three, then refuses', JSON.stringify(hits) === '[true,true,true,false]', hits);
    const d1 = await rest('PATCH', `texc_drafts?proposal_id=eq.${pid}&version=eq.1`, { config: { meta: { project: 'One' } }, version: 2 });
    const d2 = await rest('PATCH', `texc_drafts?proposal_id=eq.${pid}&version=eq.1`, { config: { meta: { project: 'Two' } }, version: 2 });
    ok('a draft save on a stale version matches nothing (the conflict check)', d1.json.length === 1 && d2.json.length === 0, [d1.json.length, d2.json.length]);
    const big = await rest('PATCH', `texc_drafts?proposal_id=eq.${pid}`, { config: { x: 'y'.repeat(1100000) } });
    ok('a draft over 1 MB is refused by the database', !big.ok, big.status);
    return { ran: true, results };
  } finally {
    sb.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('\nStanding supabase/schema.sql up on a fresh local Postgres + PostgREST');
  const out = await runSchemaProof({ log: (l) => console.log(l) });
  if (!out.ran) { console.log(`\nNOT RUN — ${out.reason}`); process.exit(2); }
  const failed = out.results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : `\nAll ${out.results.length} held.`);
  process.exit(failed ? 1 : 0);
}

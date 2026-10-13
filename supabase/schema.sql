-- ============================================================================
-- TEXC Proposals — the database (Supabase Postgres, ap-southeast-2).
--
-- The single source of truth for every table, function and trigger the app
-- relies on. Idempotent: it stands up an empty database and can be re-run on
-- one that already has it. `node scripts/schema-standup-check.mjs` proves both,
-- then attacks the result as `anon` (what a leaked public key gets).
--
-- Rules, from the Roberts repo and docs/architecture.md §7:
--   * Row-level security is ON for every table, with ZERO policies, and every
--     grant to anon/authenticated is revoked. Only the server (service_role,
--     which bypasses RLS) reads or writes anything.
--   * Every function is SECURITY DEFINER with search_path pinned to '' and
--     execute revoked from public, anon and authenticated.
--   * Published revisions are immutable. Triggers refuse UPDATE of their
--     content, DELETE and TRUNCATE; superseded_at and withdrawn_at can each be
--     set once. Events, views and the staff audit are append-only. The only way
--     through is a transaction-local flag (texc.purge) a later phase's
--     super-only purge sets.
--   * Column order is load-bearing (a positional restore matches by position):
--     a column added later is appended with `alter table … add column`, never
--     tidied into the create table.
--   * Times are UTC (timestamptz). Money is integer cents.
-- ============================================================================

-- ---------------------------------------------------------------- helpers

create or replace function public.texc_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Refuses any change at all. Used for append-only tables.
create or replace function public.texc_refuse_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('texc.purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception '% is append-only (% refused)', tg_table_name, tg_op using errcode = '42501';
end $$;

-- ---------------------------------------------------------------- accounts

create table if not exists public.texc_users (
  email        text primary key,
  name         text not null default '',
  role         text not null default 'viewer' check (role in ('admin', 'editor', 'viewer')),
  status       text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  note         text not null default '',
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  text,
  last_seen_at timestamptz
);

-- One-time sign-in codes. Only sha256(email:code) is stored, never the code.
create table if not exists public.texc_login_tokens (
  token_hash  text primary key,
  email       text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  ip_hash     text,
  created_at  timestamptz not null default now()
);
create index if not exists texc_login_tokens_email on public.texc_login_tokens (email) where consumed_at is null;

-- Sessions. Only sha256(token) is stored; the cookie holds the token.
create table if not exists public.texc_user_sessions (
  token_hash   text primary key,
  email        text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  device       text not null default ''
);
create index if not exists texc_user_sessions_email on public.texc_user_sessions (email) where revoked_at is null;

-- ---------------------------------------------------------------- proposals

create table if not exists public.texc_proposals (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9]{10}$'),
  reference           text unique,
  project             text not null default '',
  site_locality       text not null default '',
  site_region         text not null default '',
  client_company      text not null default '',
  services            text[] not null default '{}',
  doc_type            text not null default 'shotfiring',
  status              text not null default 'draft' check (status in ('draft', 'issued', 'withdrawn')),
  current_revision_id uuid,
  access_token        text unique check (access_token is null or access_token ~ '^[a-f0-9]{64}$'),
  passphrase_enc      text,
  issued_at           timestamptz,
  link_expires_at     timestamptz,
  valid_until         date,
  value_cents         bigint,
  first_opened_at     timestamptz,
  last_opened_at      timestamptz,
  open_count          integer not null default 0,
  is_test             boolean not null default false,
  created_at          timestamptz not null default now(),
  created_by          text not null default '',
  updated_at          timestamptz not null default now()
);
drop trigger if exists texc_proposals_touch on public.texc_proposals;
create trigger texc_proposals_touch before update on public.texc_proposals
  for each row execute function public.texc_touch_updated_at();

-- A published revision: the exact bytes the client decrypts, and what they say.
create table if not exists public.texc_proposal_revisions (
  id                   uuid primary key default gen_random_uuid(),
  proposal_id          uuid not null references public.texc_proposals (id),
  rev_index            integer not null check (rev_index >= 1),
  rev_label            text not null,
  enc                  text not null,
  enc_sha256           text not null check (enc_sha256 ~ '^[a-f0-9]{64}$'),
  published_text       text not null,
  plaintext_sha256     text not null check (plaintext_sha256 ~ '^[a-f0-9]{64}$'),
  view_token_hash      text not null check (view_token_hash ~ '^[a-f0-9]{64}$'),
  template_version     integer not null,
  quote_snapshot       jsonb not null,
  terms_version        text,
  attachments_snapshot jsonb not null default '[]'::jsonb,
  change_note          text not null default '',
  published_at         timestamptz not null default now(),
  published_by         text not null,
  superseded_at        timestamptz,
  withdrawn_at         timestamptz,
  unique (proposal_id, rev_index)
);

do $$ begin
  alter table public.texc_proposals add constraint texc_proposals_current_revision_fk
    foreign key (current_revision_id) references public.texc_proposal_revisions (id);
exception when duplicate_object then null; end $$;

-- Content columns never change. superseded_at and withdrawn_at are set once.
create or replace function public.texc_revisions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('texc.purge', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a published revision cannot be deleted' using errcode = '42501';
  end if;
  if (new.id, new.proposal_id, new.rev_index, new.rev_label, new.enc, new.enc_sha256, new.published_text,
      new.plaintext_sha256, new.view_token_hash, new.template_version, new.quote_snapshot, new.terms_version,
      new.attachments_snapshot, new.change_note, new.published_at, new.published_by)
     is distinct from
     (old.id, old.proposal_id, old.rev_index, old.rev_label, old.enc, old.enc_sha256, old.published_text,
      old.plaintext_sha256, old.view_token_hash, old.template_version, old.quote_snapshot, old.terms_version,
      old.attachments_snapshot, old.change_note, old.published_at, old.published_by) then
    raise exception 'a published revision cannot be changed' using errcode = '42501';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'superseded_at is set once' using errcode = '42501';
  end if;
  if old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at then
    raise exception 'withdrawn_at is set once' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists texc_revisions_guard on public.texc_proposal_revisions;
create trigger texc_revisions_guard before update or delete on public.texc_proposal_revisions
  for each row execute function public.texc_revisions_guard();
drop trigger if exists texc_revisions_no_truncate on public.texc_proposal_revisions;
create trigger texc_revisions_no_truncate before truncate on public.texc_proposal_revisions
  for each statement execute function public.texc_refuse_change();

-- How each revision's content key is wrapped by the proposal passphrase.
-- Mutable on purpose: rotating the passphrase re-wraps these and leaves the
-- revision's ciphertext — and its hash — exactly as published.
create table if not exists public.texc_revision_keys (
  revision_id uuid primary key references public.texc_proposal_revisions (id),
  kdf         text not null,
  iter        integer not null check (iter >= 100000),
  salt        text not null,
  iv          text not null,
  wrapped     text not null,
  updated_at  timestamptz not null default now()
);
drop trigger if exists texc_revision_keys_touch on public.texc_revision_keys;
create trigger texc_revision_keys_touch before update on public.texc_revision_keys
  for each row execute function public.texc_touch_updated_at();

-- The editor's working copy. One per proposal; `version` is the optimistic lock.
create table if not exists public.texc_drafts (
  proposal_id      uuid primary key references public.texc_proposals (id),
  config           jsonb not null default '{}'::jsonb check (octet_length(config::text) <= 1048576),
  version          integer not null default 1,
  base_revision_id uuid references public.texc_proposal_revisions (id),
  updated_at       timestamptz not null default now(),
  updated_by       text not null default ''
);

-- What happened to a proposal, in order. Append-only.
create table if not exists public.texc_events (
  id          bigint generated always as identity primary key,
  proposal_id uuid not null references public.texc_proposals (id),
  revision_id uuid references public.texc_proposal_revisions (id),
  event       text not null,
  session     text,
  actor       text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists texc_events_proposal on public.texc_events (proposal_id, created_at);
drop trigger if exists texc_events_append_only on public.texc_events;
create trigger texc_events_append_only before update or delete on public.texc_events
  for each row execute function public.texc_refuse_change();
drop trigger if exists texc_events_no_truncate on public.texc_events;
create trigger texc_events_no_truncate before truncate on public.texc_events
  for each statement execute function public.texc_refuse_change();

-- Every open of a client page. Append-only.
create table if not exists public.texc_proposal_views (
  id          bigint generated always as identity primary key,
  proposal_id uuid not null references public.texc_proposals (id),
  revision_id uuid references public.texc_proposal_revisions (id),
  session     text,
  device      text not null default '',
  region      text not null default '',
  ip_hash     text,
  created_at  timestamptz not null default now()
);
create index if not exists texc_proposal_views_proposal on public.texc_proposal_views (proposal_id, created_at);
drop trigger if exists texc_views_append_only on public.texc_proposal_views;
create trigger texc_views_append_only before update or delete on public.texc_proposal_views
  for each row execute function public.texc_refuse_change();
drop trigger if exists texc_views_no_truncate on public.texc_proposal_views;
create trigger texc_views_no_truncate before truncate on public.texc_proposal_views
  for each statement execute function public.texc_refuse_change();

-- ---------------------------------------------------------------- settings, counters, limits, audit

create table if not exists public.texc_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

create table if not exists public.texc_counters (
  key   text primary key,
  value integer not null default 0
);

create table if not exists public.texc_rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         integer not null
);

-- Who did what on the staff side. Append-only.
create table if not exists public.texc_staff_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  role        text not null default '',
  action      text not null,
  proposal_id uuid,
  target      text,
  detail      jsonb not null default '{}'::jsonb,
  ip_hash     text
);
create index if not exists texc_staff_audit_at on public.texc_staff_audit (at);
drop trigger if exists texc_audit_append_only on public.texc_staff_audit;
create trigger texc_audit_append_only before update or delete on public.texc_staff_audit
  for each row execute function public.texc_refuse_change();
drop trigger if exists texc_audit_no_truncate on public.texc_staff_audit;
create trigger texc_audit_no_truncate before truncate on public.texc_staff_audit
  for each statement execute function public.texc_refuse_change();

-- ---------------------------------------------------------------- functions

-- One fixed-window counter per key, in a single atomic upsert: two requests
-- landing together cannot both read "one under the limit". true = allowed.
create or replace function public.texc_rate_hit(p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.texc_rate_limits as r (key, window_start, hits)
  values (left(p_key, 160), now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into n;
  return n <= p_max;
end $$;

-- A proposal's reference, allocated the first time it is published and kept
-- for good. Numbers run per year with no gaps between proposals. Returns the
-- reference, e.g. TEXC-P-2026-007 (the prefix, TEXC-P, comes from lib/brand.js).
create or replace function public.texc_claim_reference(p_proposal uuid, p_prefix text)
returns text language plpgsql security definer set search_path = '' as $$
declare ref text; yr integer := extract(year from (now() at time zone 'Australia/Hobart'))::integer; n integer;
begin
  select reference into ref from public.texc_proposals where id = p_proposal for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if ref is not null then return ref; end if;
  insert into public.texc_counters as c (key, value) values ('reference:' || yr, 1)
  on conflict (key) do update set value = c.value + 1
  returning value into n;
  ref := p_prefix || '-' || yr || '-' || lpad(n::text, 3, '0');
  update public.texc_proposals set reference = ref where id = p_proposal;
  return ref;
end $$;

-- Errors use PostgREST's PTxyz codes, which reach the caller as that HTTP
-- status: PT409 conflict, PT404 not found. (40001 would be retried.)
--
-- Publish one revision, all or nothing, with the proposal row locked:
-- insert the revision and its key wrap, supersede the previous one, point the
-- proposal at the new one, set the link and passphrase on first issue, note it
-- on the draft, and log it. The caller built the bytes for rev_index; if anyone
-- published in between, this refuses with 'conflict' and nothing is written.
create or replace function public.texc_publish(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prop public.texc_proposals%rowtype;
  next_index integer;
  rev_id uuid;
  prev_id uuid;
begin
  select * into prop from public.texc_proposals where id = (p->>'proposal_id')::uuid for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if prop.reference is null or prop.reference is distinct from p->>'reference' then
    raise exception 'conflict: reference' using errcode = 'PT409';
  end if;
  select coalesce(max(rev_index), 0) + 1 into next_index from public.texc_proposal_revisions where proposal_id = prop.id;
  if next_index <> (p->>'rev_index')::integer then
    raise exception 'conflict: another revision was published' using errcode = 'PT409';
  end if;
  -- The link and passphrase are set once, on first issue, and only rotated on purpose.
  if prop.access_token is not null and prop.access_token is distinct from p->>'access_token' then
    raise exception 'conflict: link' using errcode = 'PT409';
  end if;
  if prop.passphrase_enc is not null and prop.passphrase_enc is distinct from p->>'passphrase_enc' then
    raise exception 'conflict: passphrase' using errcode = 'PT409';
  end if;

  insert into public.texc_proposal_revisions
    (proposal_id, rev_index, rev_label, enc, enc_sha256, published_text, plaintext_sha256, view_token_hash,
     template_version, quote_snapshot, terms_version, attachments_snapshot, change_note, published_by)
  values
    (prop.id, next_index, p->>'rev_label', p->>'enc', p->>'enc_sha256', p->>'published_text', p->>'plaintext_sha256',
     p->>'view_token_hash', (p->>'template_version')::integer, coalesce(p->'quote_snapshot', '{}'::jsonb),
     nullif(p->>'terms_version', ''), coalesce(p->'attachments_snapshot', '[]'::jsonb), coalesce(p->>'change_note', ''),
     p->>'published_by')
  returning id into rev_id;

  insert into public.texc_revision_keys (revision_id, kdf, iter, salt, iv, wrapped)
  values (rev_id, p->'key'->>'kdf', (p->'key'->>'iter')::integer, p->'key'->>'salt', p->'key'->>'iv', p->'key'->>'wrapped');

  prev_id := prop.current_revision_id;
  if prev_id is not null then
    update public.texc_proposal_revisions set superseded_at = now() where id = prev_id and superseded_at is null;
  end if;

  update public.texc_proposals set
    current_revision_id = rev_id,
    status = 'issued',
    access_token = coalesce(prop.access_token, p->>'access_token'),
    passphrase_enc = coalesce(prop.passphrase_enc, p->>'passphrase_enc'),
    issued_at = coalesce(prop.issued_at, now()),
    link_expires_at = (p->>'link_expires_at')::timestamptz,
    valid_until = (p->>'valid_until')::date,
    value_cents = (p->>'value_cents')::bigint,
    project = coalesce(p->>'project', ''),
    site_locality = coalesce(p->>'site_locality', ''),
    site_region = coalesce(p->>'site_region', ''),
    client_company = coalesce(p->>'client_company', ''),
    services = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'services', '[]'::jsonb)) x), '{}'),
    doc_type = coalesce(p->>'doc_type', prop.doc_type)
  where id = prop.id;

  update public.texc_drafts set base_revision_id = rev_id where proposal_id = prop.id;

  insert into public.texc_events (proposal_id, revision_id, event, actor, meta)
  values (prop.id, rev_id, 'published', p->>'published_by',
          jsonb_build_object('rev', p->>'rev_label', 'superseded', prev_id));

  return jsonb_build_object('revision_id', rev_id, 'rev_index', next_index, 'rev_label', p->>'rev_label', 'reference', prop.reference);
end $$;

-- A new link and passphrase. Every revision's key is re-wrapped under the new
-- passphrase in the same transaction; the published ciphertext is untouched.
-- The old link stops working the moment this commits.
create or replace function public.texc_rotate(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prop public.texc_proposals%rowtype;
  k jsonb;
  have integer;
  given integer;
begin
  select * into prop from public.texc_proposals where id = (p->>'proposal_id')::uuid for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if prop.passphrase_enc is distinct from p->>'old_passphrase_enc' then
    raise exception 'conflict: passphrase changed' using errcode = 'PT409';
  end if;
  select count(*) into have from public.texc_proposal_revisions where proposal_id = prop.id;
  given := jsonb_array_length(coalesce(p->'keys', '[]'::jsonb));
  if have <> given then raise exception 'conflict: every revision must be re-wrapped' using errcode = 'PT409'; end if;
  for k in select * from jsonb_array_elements(p->'keys') loop
    update public.texc_revision_keys set kdf = k->>'kdf', iter = (k->>'iter')::integer, salt = k->>'salt', iv = k->>'iv', wrapped = k->>'wrapped'
    where revision_id = (k->>'revision_id')::uuid
      and revision_id in (select id from public.texc_proposal_revisions where proposal_id = prop.id);
    if not found then raise exception 'conflict: unknown revision' using errcode = 'PT409'; end if;
  end loop;
  update public.texc_proposals set access_token = p->>'access_token', passphrase_enc = p->>'passphrase_enc' where id = prop.id;
  insert into public.texc_events (proposal_id, event, actor) values (prop.id, 'link_rotated', p->>'actor');
  return jsonb_build_object('ok', true);
end $$;

-- Withdraw the current revision: the link then refuses like any dead link.
-- Publishing again issues a new revision behind the same link.
create or replace function public.texc_withdraw(p_proposal uuid, p_actor text, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prop public.texc_proposals%rowtype;
begin
  select * into prop from public.texc_proposals where id = p_proposal for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if prop.current_revision_id is null then raise exception 'nothing published' using errcode = 'PT404'; end if;
  update public.texc_proposal_revisions set withdrawn_at = now() where id = prop.current_revision_id and withdrawn_at is null;
  update public.texc_proposals set status = 'withdrawn' where id = prop.id;
  insert into public.texc_events (proposal_id, revision_id, event, actor, meta)
  values (prop.id, prop.current_revision_id, 'withdrawn', p_actor, jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
  return jsonb_build_object('ok', true);
end $$;

-- A client opened the page: log the view and keep the proposal's counters in
-- step, atomically. Returns whether this was the first open ever.
create or replace function public.texc_record_view(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare first boolean;
begin
  insert into public.texc_proposal_views (proposal_id, revision_id, session, device, region, ip_hash)
  values ((p->>'proposal_id')::uuid, (p->>'revision_id')::uuid, left(p->>'session', 64), left(coalesce(p->>'device', ''), 60),
          left(coalesce(p->>'region', ''), 20), left(p->>'ip_hash', 32));
  update public.texc_proposals set
    first_opened_at = coalesce(first_opened_at, now()),
    last_opened_at = now(),
    open_count = open_count + 1
  where id = (p->>'proposal_id')::uuid
  returning open_count = 1 into first;
  return jsonb_build_object('first', coalesce(first, false));
end $$;

-- ---------------------------------------------------------------- attachments (Phase 4)

-- The files (PDFs) uploaded to a proposal: the facts about each file and the
-- result of its structural check (lib/pdf-inspect.js). How a file is presented
-- — its title, group, who may open it — lives on the draft's document card,
-- which points here by id; a published revision binds the exact files it
-- offered in texc_proposal_revisions.attachments_snapshot. Stored paths are
-- content-addressed and never overwritten.
create table if not exists public.texc_attachments (
  id              uuid primary key default gen_random_uuid(),
  proposal_id     uuid not null references public.texc_proposals (id),
  storage_path    text not null,
  original_name   text not null default '',
  sha256          text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  bytes           bigint not null default 0,
  pages           integer,
  thumb_path      text,
  scan_status     text not null default 'pending' check (scan_status in ('pending', 'clean', 'rejected', 'cannot-verify', 'override')),
  scan_detail     jsonb not null default '{}'::jsonb,
  scanned_at      timestamptz,
  override_by     text,
  override_reason text,
  source          text not null default 'upload' check (source in ('upload', 'suite')),
  source_ref      text,
  uploaded_by     text not null,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  unique (proposal_id, sha256)
);
create index if not exists texc_attachments_proposal on public.texc_attachments (proposal_id);

-- ---------------------------------------------------------------- locked down from birth

do $$
declare t text;
begin
  foreach t in array array['texc_users', 'texc_login_tokens', 'texc_user_sessions', 'texc_proposals',
    'texc_proposal_revisions', 'texc_revision_keys', 'texc_drafts', 'texc_events', 'texc_proposal_views',
    'texc_settings', 'texc_counters', 'texc_rate_limits', 'texc_staff_audit', 'texc_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['texc_touch_updated_at()', 'texc_refuse_change()', 'texc_revisions_guard()',
    'texc_rate_hit(text, integer, integer)', 'texc_claim_reference(uuid, text)', 'texc_publish(jsonb)',
    'texc_rotate(jsonb)', 'texc_withdraw(uuid, text, text)', 'texc_record_view(jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- storage buckets

-- The three buckets, PRIVATE, with their size and type limits, declared here
-- so privacy never rests on a dashboard setting. Supabase only: a plain
-- Postgres (the local proof) has no storage schema, and this is skipped.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
      ('texc-media', 'texc-media', false, 3145728, array['image/webp', 'image/jpeg']),
      ('texc-attachments', 'texc-attachments', false, 26214400, array['application/pdf']),
      ('texc-acceptances', 'texc-acceptances', false, 1048576, array['image/png', 'text/html'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

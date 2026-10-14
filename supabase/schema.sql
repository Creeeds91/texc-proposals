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
  if prop.archived_at is not null then raise exception 'conflict: archived' using errcode = 'PT409'; end if;
  if prop.reference is null or prop.reference is distinct from p->>'reference' then
    raise exception 'conflict: reference' using errcode = 'PT409';
  end if;
  select coalesce(max(rev_index), 0) + 1 into next_index from public.texc_proposal_revisions where proposal_id = prop.id;
  if next_index <> (p->>'rev_index')::integer then
    raise exception 'conflict: another revision was published' using errcode = 'PT409';
  end if;
  -- The caller checked whether the current revision was accepted (publishing
  -- over an acceptance needs acknowledging); if a client accepted since, stop.
  if p ? 'current_accepted' and exists (select 1 from public.texc_acceptances where revision_id = prop.current_revision_id)
     is distinct from (p->>'current_accepted')::boolean then
    raise exception 'conflict: accepted meanwhile' using errcode = 'PT409';
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
    doc_type = coalesce(p->>'doc_type', prop.doc_type),
    search_extra = left(coalesce(p->>'search_extra', ''), 4000)
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

-- ---------------------------------------------------------------- acceptance (Phase 5)

-- Which revision was last accepted, and when. Appended (column order is load-bearing).
alter table public.texc_proposals add column if not exists accepted_at timestamptz;
alter table public.texc_proposals add column if not exists accepted_revision_id uuid references public.texc_proposal_revisions (id);

-- One acceptance per revision, kept exactly as given. Append-only.
--   client  the client accepted on the page: both confirmations, a signature,
--           and the SHA-256 of the exact bytes they decrypted, which must equal
--           the revision's — proof they accepted what was published
--   staff   recorded by an administrator for an acceptance received another
--           way (a signed PDF, an email), with a note saying how
-- The record (record_path) is the acceptance as an HTML page, rendered and
-- stored at the moment of acceptance; record_sha256 fingerprints it.
create table if not exists public.texc_acceptances (
  id                   uuid primary key,
  proposal_id          uuid not null references public.texc_proposals (id),
  revision_id          uuid not null unique references public.texc_proposal_revisions (id),
  kind                 text not null check (kind in ('client', 'staff')),
  accepted_at          timestamptz not null,
  name                 text not null check (length(name) between 1 and 160),
  position             text not null default '',
  company              text not null default '',
  email                text not null default '',
  authority_confirmed  boolean not null default false,
  terms_confirmed      boolean not null default false,
  terms_version        text,
  clauses              jsonb not null default '{}'::jsonb,
  signature_kind       text not null default 'none' check (signature_kind in ('drawn', 'typed', 'drawn+typed', 'none')),
  signature_path       text,
  signature_sha256     text check (signature_sha256 is null or signature_sha256 ~ '^[a-f0-9]{64}$'),
  typed_signature      text,
  options              jsonb not null default '[]'::jsonb,
  accepted_total_cents bigint,
  totals               jsonb not null default '{}'::jsonb,
  plaintext_sha256     text check (plaintext_sha256 is null or plaintext_sha256 ~ '^[a-f0-9]{64}$'),
  enc_sha256           text check (enc_sha256 is null or enc_sha256 ~ '^[a-f0-9]{64}$'),
  ip_hash              text,
  ua_family            text not null default '',
  session              text,
  recorded_by          text,
  staff_note           text,
  record_path          text not null,
  record_sha256        text not null check (record_sha256 ~ '^[a-f0-9]{64}$'),
  created_at           timestamptz not null default now(),
  check ((kind = 'client' and authority_confirmed and terms_confirmed and plaintext_sha256 is not null and signature_kind <> 'none')
      or (kind = 'staff' and recorded_by is not null and length(coalesce(staff_note, '')) >= 10))
);
create index if not exists texc_acceptances_proposal on public.texc_acceptances (proposal_id);
drop trigger if exists texc_acceptances_append_only on public.texc_acceptances;
create trigger texc_acceptances_append_only before update or delete on public.texc_acceptances
  for each row execute function public.texc_refuse_change();
drop trigger if exists texc_acceptances_no_truncate on public.texc_acceptances;
create trigger texc_acceptances_no_truncate before truncate on public.texc_acceptances
  for each statement execute function public.texc_refuse_change();

-- Accept a revision, all or nothing, with the proposal row locked — so of any
-- number of simultaneous attempts exactly one is written and the rest are told
-- who accepted it ({ won: false, … }), the same answer as a second tap gets.
-- Only the current revision of an issued proposal can be accepted, never a
-- superseded or withdrawn one; a client must still hold a live link and must
-- name the exact bytes that were published. The caller has already stored the
-- signature and the record at the paths it passes.
create or replace function public.texc_accept(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prop public.texc_proposals%rowtype;
  rev public.texc_proposal_revisions%rowtype;
  had public.texc_acceptances%rowtype;
  is_client boolean := p->>'kind' = 'client';
begin
  select * into prop from public.texc_proposals where id = (p->>'proposal_id')::uuid for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if prop.archived_at is not null then raise exception 'conflict: archived' using errcode = 'PT409'; end if;
  select * into rev from public.texc_proposal_revisions where id = (p->>'revision_id')::uuid and proposal_id = prop.id;
  if not found then raise exception 'no such revision' using errcode = 'PT404'; end if;
  select * into had from public.texc_acceptances where revision_id = rev.id;
  if found then
    return jsonb_build_object('won', false, 'id', had.id, 'accepted_at', had.accepted_at, 'name', had.name, 'kind', had.kind);
  end if;
  if prop.status <> 'issued' or prop.current_revision_id is distinct from rev.id or rev.superseded_at is not null or rev.withdrawn_at is not null then
    raise exception 'conflict: this revision is not open for acceptance' using errcode = 'PT409';
  end if;
  if is_client and prop.link_expires_at is not null and prop.link_expires_at <= now() then
    raise exception 'conflict: the link has expired' using errcode = 'PT409';
  end if;
  if is_client and rev.plaintext_sha256 is distinct from p->>'plaintext_sha256' then
    raise exception 'conflict: not the published text' using errcode = 'PT409';
  end if;

  insert into public.texc_acceptances
    (id, proposal_id, revision_id, kind, accepted_at, name, position, company, email, authority_confirmed, terms_confirmed,
     terms_version, clauses, signature_kind, signature_path, signature_sha256, typed_signature, options, accepted_total_cents,
     totals, plaintext_sha256, enc_sha256, ip_hash, ua_family, session, recorded_by, staff_note, record_path, record_sha256)
  values
    ((p->>'id')::uuid, prop.id, rev.id, p->>'kind', (p->>'accepted_at')::timestamptz, p->>'name', coalesce(p->>'position', ''),
     coalesce(p->>'company', ''), coalesce(p->>'email', ''), coalesce((p->>'authority_confirmed')::boolean, false),
     coalesce((p->>'terms_confirmed')::boolean, false), nullif(p->>'terms_version', ''), coalesce(p->'clauses', '{}'::jsonb),
     coalesce(p->>'signature_kind', 'none'), nullif(p->>'signature_path', ''), nullif(p->>'signature_sha256', ''),
     nullif(p->>'typed_signature', ''), coalesce(p->'options', '[]'::jsonb), (p->>'accepted_total_cents')::bigint,
     coalesce(p->'totals', '{}'::jsonb), case when is_client then rev.plaintext_sha256 end, rev.enc_sha256,
     left(p->>'ip_hash', 32), left(coalesce(p->>'ua_family', ''), 60), left(p->>'session', 64),
     nullif(p->>'recorded_by', ''), nullif(p->>'staff_note', ''), p->>'record_path', p->>'record_sha256');

  update public.texc_proposals set accepted_at = (p->>'accepted_at')::timestamptz, accepted_revision_id = rev.id where id = prop.id;
  insert into public.texc_events (proposal_id, revision_id, event, session, actor, meta)
  values (prop.id, rev.id, case when is_client then 'accepted' else 'acceptance_recorded' end, left(p->>'session', 64),
          case when is_client then null else p->>'recorded_by' end,
          jsonb_build_object('acceptance', p->>'id', 'rev', rev.rev_label, 'total_cents', (p->>'accepted_total_cents')::bigint));
  return jsonb_build_object('won', true, 'id', p->>'id', 'accepted_at', p->>'accepted_at', 'name', p->>'name', 'kind', p->>'kind');
end $$;

-- ---------------------------------------------------------------- archive, search and reporting (Phase 6)

-- Archiving files a proposal away; it is not a withdrawal, and its status and
-- history stay exactly as they were. While archived, its client link refuses
-- like any dead link, nothing can be saved, published or accepted on it, and
-- it leaves the editor's list. Restoring brings all of that back (a link still
-- within its expiry opens again). Deleting is not here: that is a later
-- phase's super-only purge.
alter table public.texc_proposals add column if not exists archived_at timestamptz;
alter table public.texc_proposals add column if not exists archived_by text;
alter table public.texc_proposals add column if not exists archive_reason text;
-- Words staff search by that are not columns of their own (service names,
-- document type, the contact, document titles). Written at publish, and on
-- each save while a proposal has never been issued.
alter table public.texc_proposals add column if not exists search_extra text not null default '';
-- Generated, so it is never written, never stale, and never part of a restore
-- (COPY skips generated columns; the column-order check ignores it).
alter table public.texc_proposals add column if not exists search tsvector generated always as (
  to_tsvector('simple'::regconfig, coalesce(reference, '') || ' ' || project || ' ' || client_company || ' '
    || site_locality || ' ' || site_region || ' ' || search_extra)) stored;
create index if not exists texc_proposals_search on public.texc_proposals using gin (search);

-- Archive (p.archive = true, with a reason) or restore (false). Saying the
-- state it is already in changes nothing and logs nothing.
create or replace function public.texc_set_archived(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prop public.texc_proposals%rowtype;
  want boolean := (p->>'archive')::boolean;
  why text := left(btrim(coalesce(p->>'reason', '')), 300);
begin
  if want is null then raise exception 'archive must be true or false' using errcode = '22023'; end if;
  select * into prop from public.texc_proposals where id = (p->>'proposal_id')::uuid for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if (prop.archived_at is not null) = want then
    return jsonb_build_object('changed', false, 'archived_at', prop.archived_at);
  end if;
  if want and length(why) < 3 then raise exception 'a reason is needed' using errcode = '22023'; end if;
  update public.texc_proposals set
    archived_at = case when want then now() end,
    archived_by = case when want then p->>'actor' end,
    archive_reason = case when want then why end
  where id = prop.id;
  insert into public.texc_events (proposal_id, event, actor, meta)
  values (prop.id, case when want then 'archived' else 'restored' end, p->>'actor',
          case when want then jsonb_build_object('reason', why)
               else jsonb_build_object('archived_at', prop.archived_at, 'reason', prop.archive_reason) end);
  return jsonb_build_object('changed', true, 'archived_at', case when want then now() end);
end $$;

-- Staff search: every word is a prefix ("ash civ" finds Ashgrove Civil), all
-- must match, and a reference matches on any part of it. Only letters and
-- digits ever reach the query, so nothing typed can be an operator.
create or replace function public.texc_search(p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  q text := lower(btrim(left(coalesce(p_q, ''), 200)));
  words text[];
begin
  select array_agg(w) into words from (
    select w from regexp_split_to_table(regexp_replace(q, '[^[:alnum:]]+', ' ', 'g'), ' ') w where w <> '' limit 8) s;
  if words is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(id) from (
    select pr.id from public.texc_proposals pr
    where pr.search @@ to_tsquery('simple'::regconfig, array_to_string(array(select x || ':*' from unnest(words) x), ' & '))
       or (pr.reference is not null and strpos(lower(pr.reference), q) > 0)
    order by pr.updated_at desc limit 500) s), '[]'::jsonb);
end $$;

-- One row per proposal for the dashboard: its own columns, its current
-- revision, acceptance on that revision and ever, and how the client has
-- engaged with the current revision. Counting happens here; deciding what a
-- row means (lifecycle, follow-ups, win rate) is assets/js/lifecycle.js.
create or replace function public.texc_overview(p jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(o) order by o.updated_at desc), '[]'::jsonb) from (
    select pr.id, pr.reference, pr.project, pr.client_company, pr.site_locality, pr.site_region, pr.services,
      pr.doc_type, pr.status, pr.issued_at, pr.link_expires_at, pr.valid_until, pr.value_cents, pr.first_opened_at,
      pr.last_opened_at, pr.open_count, pr.accepted_at, pr.archived_at, pr.archived_by, pr.archive_reason, pr.is_test,
      pr.created_at, pr.created_by, pr.updated_at,
      cur.rev_label as rev, cur.published_at as rev_published_at, cur.published_by as rev_published_by,
      (select count(*) from public.texc_proposal_revisions r where r.proposal_id = pr.id) as revisions,
      acc.accepted_at as current_accepted_at, acc.kind as current_accepted_kind, acc.name as current_accepted_by,
      (acc.totals->>'subtotal')::bigint as current_accepted_subtotal_cents,
      ever.first_accepted_at, ever.last_accepted_rev, ever.last_accepted_subtotal_cents,
      v.views_current, v.sessions_current, v.last_view_current,
      e.docs_opened_current, e.options_current, e.changes_requested_at,
      dx.docs_expire_on,
      dr.updated_at as draft_updated_at, dr.updated_by as draft_updated_by,
      left(coalesce(dr.config->'client'->>'contactName', ''), 160) as contact
    from public.texc_proposals pr
    left join public.texc_proposal_revisions cur on cur.id = pr.current_revision_id
    left join public.texc_acceptances acc on acc.revision_id = pr.current_revision_id
    left join lateral (
      select min(a.accepted_at) as first_accepted_at,
        (array_agg(r.rev_label order by a.accepted_at desc))[1] as last_accepted_rev,
        (array_agg((a.totals->>'subtotal')::bigint order by a.accepted_at desc))[1] as last_accepted_subtotal_cents
      from public.texc_acceptances a join public.texc_proposal_revisions r on r.id = a.revision_id
      where a.proposal_id = pr.id) ever on true
    left join lateral (
      select count(*) as views_current, count(distinct w.session) as sessions_current, max(w.created_at) as last_view_current
      from public.texc_proposal_views w where w.proposal_id = pr.id and w.revision_id = pr.current_revision_id) v on true
    left join lateral (
      select count(*) filter (where ev.event in ('attachment_opened', 'attachment_downloaded')) as docs_opened_current,
        count(*) filter (where ev.event = 'option_toggled') as options_current,
        max(ev.created_at) filter (where ev.event = 'changes_requested') as changes_requested_at
      from public.texc_events ev where ev.proposal_id = pr.id and ev.revision_id = pr.current_revision_id) e on true
    -- Phase 8: the soonest a document the current revision sent lapses (a library document's expiry, frozen in its snapshot).
    left join lateral (
      select min((x->>'expiresOn')::date) as docs_expire_on
      from jsonb_array_elements(case when jsonb_typeof(cur.attachments_snapshot) = 'array' then cur.attachments_snapshot else '[]'::jsonb end) x
      where coalesce(x->>'expiresOn', '') ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$') dx on true
    left join public.texc_drafts dr on dr.proposal_id = pr.id
    where coalesce((p->>'archived')::boolean, true) or pr.archived_at is null
    order by pr.updated_at desc
    limit greatest(1, least(coalesce((p->>'limit')::integer, 2000), 5000))
  ) o
$$;

-- ---------------------------------------------------------------- hardening (Phase 7)

-- An archived proposal takes no saves, in the database as well as on the
-- server: the server checks first, and this closes the moment between its
-- check and its write.
create or replace function public.texc_drafts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.texc_proposals where id = new.proposal_id and archived_at is not null) then
    raise exception 'conflict: archived' using errcode = 'PT409';
  end if;
  return new;
end $$;
drop trigger if exists texc_drafts_guard on public.texc_drafts;
create trigger texc_drafts_guard before update on public.texc_drafts
  for each row execute function public.texc_drafts_guard();

-- ---------------------------------------------------------------- purge (Phase 7)

-- The one door through the append-only and immutability triggers: delete an
-- archived proposal and everything that hangs off it, for good. Only when it
-- has been archived for 90 days, and never once it has been accepted (an
-- acceptance is a business record and is kept) unless the keeping period
-- TEXC sets (Phase 9) has passed. The caller (lib/purge.js)
-- has checked the person is Brand in Black, recorded the deletion in the
-- staff audit first, and removes the stored files once this commits. The
-- transaction-local flag dies with the transaction; nothing else can set it.
create or replace function public.texc_purge(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prop public.texc_proposals%rowtype;
  counts jsonb;
  keep_years integer;
begin
  select * into prop from public.texc_proposals where id = (p->>'proposal_id')::uuid for update;
  if not found then raise exception 'no such proposal' using errcode = 'PT404'; end if;
  if prop.archived_at is null then raise exception 'conflict: not archived' using errcode = 'PT409'; end if;
  if prop.archived_at > now() - interval '90 days' then raise exception 'conflict: archived less than 90 days ago' using errcode = 'PT409'; end if;
  -- An accepted proposal is a business record: kept, unless TEXC has set a
  -- keeping period (Phase 9, texc_settings 'retention') and it has passed since
  -- the last acceptance. Unset, it is kept for good.
  if exists (select 1 from public.texc_acceptances where proposal_id = prop.id) then
    keep_years := (select case when (value->>'keepAcceptedYears') ~ '^[0-9]{1,3}$' then (value->>'keepAcceptedYears')::integer end
                   from public.texc_settings where key = 'retention');
    if keep_years is null or keep_years < 1
       or (select max(accepted_at) from public.texc_acceptances where proposal_id = prop.id) > now() - make_interval(years => keep_years) then
      raise exception 'conflict: accepted proposals are kept' using errcode = 'PT409';
    end if;
  end if;
  if prop.reference is distinct from nullif(p->>'reference', '') then raise exception 'conflict: reference' using errcode = 'PT409'; end if;
  counts := jsonb_build_object(
    'revisions', (select count(*) from public.texc_proposal_revisions where proposal_id = prop.id),
    'events', (select count(*) from public.texc_events where proposal_id = prop.id),
    'views', (select count(*) from public.texc_proposal_views where proposal_id = prop.id),
    'files', (select count(*) from public.texc_attachments where proposal_id = prop.id),
    'acceptances', (select count(*) from public.texc_acceptances where proposal_id = prop.id));
  perform set_config('texc.purge', 'on', true);
  delete from public.texc_drafts where proposal_id = prop.id;
  update public.texc_proposals set current_revision_id = null, accepted_revision_id = null where id = prop.id;
  delete from public.texc_revision_keys where revision_id in (select id from public.texc_proposal_revisions where proposal_id = prop.id);
  delete from public.texc_events where proposal_id = prop.id;
  delete from public.texc_proposal_views where proposal_id = prop.id;
  delete from public.texc_attachments where proposal_id = prop.id;
  delete from public.texc_acceptances where proposal_id = prop.id;
  delete from public.texc_proposal_revisions where proposal_id = prop.id;
  delete from public.texc_proposals where id = prop.id;
  perform set_config('texc.purge', 'off', true);
  return counts;
end $$;

-- ---------------------------------------------------------------- document library (Phase 8)

-- Standing documents, uploaded once and offered on any proposal: the
-- company's (policies, procedures, SWMS, insurance) and each person's
-- (licences, qualifications, their own insurance). One table whose owner is
-- the organisation or a person, as the TEXC app's EvidenceItem
-- (texc repo, documents/process/app-foundation.md), so it can move there
-- unchanged. kind is George's own filename prefixes; currency says whether
-- it lapses. A person is named by their id in the website's team list.
create table if not exists public.texc_evidence (
  id          uuid primary key default gen_random_uuid(),
  owner_kind  text not null check (owner_kind in ('organisation', 'person')),
  owner_ref   text not null default '' check (owner_ref ~ '^[a-z0-9-]{0,60}$'),
  kind        text not null check (kind in ('compliance', 'insurance', 'procedure', 'project', 'ssds')),
  title       text not null check (length(title) between 1 and 160),
  issuer      text not null default '',
  number      text not null default '',
  doc_code    text not null default '',
  currency    text not null default 'permanent' check (currency in ('permanent', 'expires', 'project')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  retired_at  timestamptz,
  retired_by  text,
  check ((owner_kind = 'organisation') = (owner_ref = ''))
);
drop trigger if exists texc_evidence_touch on public.texc_evidence;
create trigger texc_evidence_touch before update on public.texc_evidence
  for each row execute function public.texc_touch_updated_at();

-- Every file a library document has had. The current one is the latest
-- approved. Once approved a version is a record: it never changes and is
-- never deleted, because a revision that sent it points at its path. Until
-- then it can be checked, released, given its facts, approved or discarded.
create table if not exists public.texc_evidence_versions (
  id              uuid primary key default gen_random_uuid(),
  evidence_id     uuid not null references public.texc_evidence (id),
  storage_path    text not null,
  original_name   text not null default '',
  sha256          text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  bytes           bigint not null default 0,
  pages           integer,
  scan_status     text not null default 'pending' check (scan_status in ('pending', 'clean', 'rejected', 'cannot-verify', 'override')),
  scan_detail     jsonb not null default '{}'::jsonb,
  scanned_at      timestamptz,
  override_by     text,
  override_reason text,
  doc_rev         text not null default '',
  doc_date        date,
  issued_on       date,
  expires_on      date,
  uploaded_by     text not null,
  created_at      timestamptz not null default now(),
  approved_by     text,
  approved_at     timestamptz,
  unique (evidence_id, sha256)
);
create index if not exists texc_evidence_versions_item on public.texc_evidence_versions (evidence_id);

create or replace function public.texc_evidence_versions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.approved_at is not null then
      raise exception 'an approved library file cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.approved_at is not null then
    raise exception 'an approved library file cannot be changed' using errcode = '42501';
  end if;
  if new.approved_at is not null and new.scan_status not in ('clean', 'override') then
    raise exception 'only a file that passed the check, or was released, can be approved' using errcode = '42501';
  end if;
  if (new.id, new.evidence_id, new.storage_path, new.sha256) is distinct from (old.id, old.evidence_id, old.storage_path, old.sha256) then
    raise exception 'a library file keeps its identity' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists texc_evidence_versions_guard on public.texc_evidence_versions;
create trigger texc_evidence_versions_guard before update or delete on public.texc_evidence_versions
  for each row execute function public.texc_evidence_versions_guard();

-- A library document that ever had an approved file is kept (retired, never deleted).
create or replace function public.texc_evidence_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.texc_evidence_versions where evidence_id = old.id and approved_at is not null) then
    raise exception 'a library document with an approved file is retired, never deleted' using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists texc_evidence_guard on public.texc_evidence;
create trigger texc_evidence_guard before delete on public.texc_evidence
  for each row execute function public.texc_evidence_guard();

-- Where each library document is used: the revisions that sent one of its
-- files (and their proposals), and the drafts that offer it now.
create or replace function public.texc_evidence_usage()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(u.id, jsonb_build_object('revisions', u.revisions, 'proposals', u.proposals, 'drafts', u.drafts)), '{}'::jsonb)
  from (
    select ev.id::text as id,
      count(r.id) as revisions,
      count(distinct r.proposal_id) as proposals,
      (select count(*) from public.texc_drafts dr
        where dr.config->'attachments' @> jsonb_build_array(jsonb_build_object('evidence', ev.id::text))) as drafts
    from public.texc_evidence ev
    left join public.texc_proposal_revisions r
      on r.attachments_snapshot @> jsonb_build_array(jsonb_build_object('evidence', ev.id::text))
    group by ev.id
  ) u
$$;

-- ---------------------------------------------------------------- archive and retention (Phase 9)

-- The archive: one row per revision ever published, newest first, with its
-- proposal, its acceptance and the documents it offered (from the published
-- text, the client's own view, and its snapshot's fingerprints; never a
-- storage path). A revision matches when its proposal matches the dashboard's
-- search, or every word appears in the titles and codes of its documents.
create or replace function public.texc_archive(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  q text := lower(btrim(left(coalesce(p->>'q', ''), 200)));
  words text[];
  hits uuid[];
  yr integer := case when coalesce(p->>'year', '') ~ '^[0-9]{4}$' then (p->>'year')::integer end;
begin
  select array_agg(w) into words from (
    select w from regexp_split_to_table(regexp_replace(q, '[^[:alnum:]]+', ' ', 'g'), ' ') w where w <> '' limit 8) s;
  if words is not null then
    select array_agg((x #>> '{}')::uuid) into hits from jsonb_array_elements(public.texc_search(q)) x;
  end if;
  return coalesce((select jsonb_agg(to_jsonb(o) order by o.published_at desc) from (
    select pr.id as proposal_id, pr.reference, pr.project, pr.client_company, pr.site_locality, pr.site_region, pr.services,
      pr.doc_type, pr.archived_at, pr.archive_reason, pr.is_test, pr.status,
      r.id as revision_id, r.rev_label, r.rev_index, r.published_at, r.published_by, r.superseded_at, r.withdrawn_at,
      r.change_note, r.template_version, (r.id = pr.current_revision_id) as current,
      coalesce(r.published_text::jsonb -> 'attachments', '[]'::jsonb) as documents,
      (select coalesce(jsonb_agg(jsonb_build_object('card', x->>'card', 'sha256', x->>'sha256', 'bytes', x->'bytes', 'pages', x->'pages',
          'evidence', x->>'evidence', 'expiresOn', x->>'expiresOn')), '[]'::jsonb)
        from jsonb_array_elements(case when jsonb_typeof(r.attachments_snapshot) = 'array' then r.attachments_snapshot else '[]'::jsonb end) x) as files,
      (select jsonb_build_object('id', a.id, 'name', a.name, 'company', a.company, 'accepted_at', a.accepted_at, 'kind', a.kind)
        from public.texc_acceptances a where a.revision_id = r.id) as acceptance
    from public.texc_proposal_revisions r
    join public.texc_proposals pr on pr.id = r.proposal_id
    where (words is null
        or pr.id = any(coalesce(hits, '{}'))
        or not exists (select 1 from unnest(words) w where strpos(lower(coalesce((
              select string_agg(coalesce(a->>'title', '') || ' ' || coalesce(a->>'docCode', ''), ' ')
              from jsonb_array_elements(coalesce(r.published_text::jsonb -> 'attachments', '[]'::jsonb)) a), '')), w) = 0))
      and (yr is null or extract(year from r.published_at at time zone 'Australia/Hobart') = yr)
      and (coalesce(p->>'service', '') = '' or pr.services @> array[p->>'service'])
      and (coalesce(p->>'region', '') = '' or pr.site_region = p->>'region')
      and (coalesce(p->>'proposal', '') = '' or pr.id::text = p->>'proposal')
    order by r.published_at desc
    limit greatest(1, least(coalesce((p->>'limit')::integer, 300), 2000))
  ) o), '[]'::jsonb);
end $$;

-- Retention (Phase 9). TEXC's keeping periods live in texc_settings under
-- 'retention': { archiveAfterDays, keepAcceptedYears }. Unset, nothing is
-- archived automatically and an accepted proposal is kept for good. This
-- archives, never deletes: a proposal that ran out without being accepted,
-- has had no change for that long either, and is not archived yet. Called
-- daily (api/retention.js); each one is archived through texc_set_archived,
-- so it is logged like any other archiving.
create or replace function public.texc_auto_archive(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  days integer := (select case when (value->>'archiveAfterDays') ~ '^[0-9]{1,4}$' then (value->>'archiveAfterDays')::integer end
                   from public.texc_settings where key = 'retention');
  today date := (now() at time zone 'Australia/Hobart')::date;
  done uuid[] := '{}';
  pid uuid;
begin
  if days is null or days < 1 then return jsonb_build_object('archived', '[]'::jsonb, 'days', null); end if;
  for pid in
    select pr.id from public.texc_proposals pr
    where pr.archived_at is null and pr.current_revision_id is not null
      and not exists (select 1 from public.texc_acceptances a where a.proposal_id = pr.id)
      and coalesce(pr.valid_until, (pr.link_expires_at at time zone 'Australia/Hobart')::date) < today - days
      and pr.updated_at < now() - make_interval(days => days)
    order by pr.updated_at
    limit greatest(1, least(coalesce((p->>'limit')::integer, 200), 1000))
  loop
    perform public.texc_set_archived(jsonb_build_object('proposal_id', pid, 'archive', true, 'actor', 'retention',
      'reason', format('Expired without acceptance (archived automatically, %s days on)', days)));
    done := done || pid;
  end loop;
  return jsonb_build_object('archived', to_jsonb(done), 'days', days);
end $$;

-- ---------------------------------------------------------------- locked down from birth

do $$
declare t text;
begin
  foreach t in array array['texc_users', 'texc_login_tokens', 'texc_user_sessions', 'texc_proposals',
    'texc_proposal_revisions', 'texc_revision_keys', 'texc_drafts', 'texc_events', 'texc_proposal_views',
    'texc_settings', 'texc_counters', 'texc_rate_limits', 'texc_staff_audit', 'texc_attachments', 'texc_acceptances',
    'texc_evidence', 'texc_evidence_versions'] loop
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
    'texc_rotate(jsonb)', 'texc_withdraw(uuid, text, text)', 'texc_record_view(jsonb)', 'texc_accept(jsonb)',
    'texc_set_archived(jsonb)', 'texc_search(text)', 'texc_overview(jsonb)', 'texc_purge(jsonb)', 'texc_drafts_guard()',
    'texc_evidence_versions_guard()', 'texc_evidence_guard()', 'texc_evidence_usage()',
    'texc_archive(jsonb)', 'texc_auto_archive(jsonb)'] loop
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

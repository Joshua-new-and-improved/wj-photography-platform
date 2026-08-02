-- ============================================================================
-- 0001_foundation.sql
-- Extensions, identifier helpers, session-context accessors, database roles.
--
-- Architecture refs: §5.1 (tenancy), §5.2 (identifiers), §15 (security).
-- ============================================================================

begin;

-- ── Extensions ───────────────────────────────────────────────────────────────
-- pgcrypto  : gen_random_uuid(), digest() for the audit hash chain
-- pg_trgm   : fuzzy child-name search (§13) and import fuzzy-matching (§7.2)
-- unaccent  : Afrikaans / SA naming — "Zané" must match "Zane" (§13)
-- citext    : case-insensitive email without lower() on every comparison
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists citext;

-- ── Schemas ──────────────────────────────────────────────────────────────────
-- app : helper functions. Kept out of public so it can be locked down.
create schema if not exists app;

-- ============================================================================
-- Identifier helpers (§5.2)
-- ============================================================================

-- UUIDv7: time-sortable primary keys. Keeps B-tree locality healthy across the
-- ~160k asset inserts a year projected in §A7, which UUIDv4 would fragment.
--
-- PostgreSQL 18 ships a native uuidv7(). We target 16, so this is a shim.
-- On 18+ this function can be dropped and the built-in used unchanged —
-- the call sites do not move.
create or replace function app.uuidv7() returns uuid
language sql volatile parallel safe
as $$
  select encode(
    set_bit(
      set_bit(
        -- Overlay the low 48 bits of a millisecond timestamp over the first
        -- 6 bytes of a random v4 UUID.
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(
            int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
            from 3
          )
          from 1 for 6
        ),
        -- PostgreSQL numbers bytea bits from the LSB of each byte, so the
        -- version nibble (high nibble of byte 6) is bit indices 55,54,53,52.
        -- gen_random_uuid() gives v4 = 0100; setting 53 and 52 makes it 0111 = 7.
        53, 1
      ),
      52, 1
    ),
    'hex'
  )::uuid;
$$;

comment on function app.uuidv7() is
  'Time-sortable UUIDv7. Shim for PostgreSQL < 18; drop in favour of the built-in on 18+.';

-- Public reference: 128 bits of entropy, base62, for anything that appears in
-- a URL. Never derived from a name, never sequential (§5.2, §6.1).
create or replace function app.public_ref() returns text
language plpgsql volatile
as $$
declare
  alphabet constant text :=
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  raw    bytea := gen_random_bytes(16);
  n      numeric := 0;
  out    text := '';
  i      int;
  digit  int;
begin
  for i in 0 .. 15 loop
    n := n * 256 + get_byte(raw, i);
  end loop;
  while n > 0 loop
    digit := (n % 62)::int;
    out   := substr(alphabet, digit + 1, 1) || out;
    n     := div(n, 62);
  end loop;
  -- Left-pad so every reference is the same visual length.
  return lpad(out, 22, '0');
end;
$$;

comment on function app.public_ref() is
  '22-char base62 from 128 random bits. For URL-visible identifiers only.';

-- unaccent() is declared STABLE because a superuser could swap the dictionary
-- out from under it, so PostgreSQL will not allow it in a generated column or
-- an expression index. This wrapper pins the dictionary explicitly and asserts
-- immutability, which is the accepted pattern.
--
-- CAVEAT: if the unaccent dictionary is ever changed, every index and generated
-- column built on this function must be rebuilt. Recorded in db/README.md.
create or replace function app.immutable_unaccent(text) returns text
language sql immutable strict parallel safe
as $$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ============================================================================
-- Session context (§5.1)
--
-- The application sets these per request/transaction with SET LOCAL. RLS
-- policies read them through these accessors. Using SET LOCAL means the
-- context dies with the transaction, so a pooled connection cannot leak one
-- request's tenant into the next.
-- ============================================================================

create or replace function app.actor_kind() returns text
language sql stable
as $$ select coalesce(nullif(current_setting('app.actor_kind', true), ''), 'none') $$;

create or replace function app.studio_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.studio_id', true), '')::uuid $$;

create or replace function app.staff_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.staff_id', true), '')::uuid $$;

create or replace function app.guardian_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.guardian_id', true), '')::uuid $$;

create or replace function app.staff_role() returns text
language sql stable
as $$ select coalesce(nullif(current_setting('app.staff_role', true), ''), 'none') $$;

-- Convenience predicates used throughout the policies.
create or replace function app.is_staff() returns boolean
language sql stable
as $$ select app.actor_kind() = 'staff' and app.studio_id() is not null $$;

create or replace function app.is_guardian() returns boolean
language sql stable
as $$ select app.actor_kind() = 'guardian' and app.guardian_id() is not null $$;

-- Role ranking, so policies can say "admin or above" without enumerating.
create or replace function app.staff_rank(role text) returns int
language sql immutable
as $$
  select case role
    when 'owner'        then 50
    when 'admin'        then 40
    when 'photographer' then 30
    when 'assistant'    then 20
    when 'viewer'       then 10
    else 0
  end;
$$;

create or replace function app.staff_at_least(required text) returns boolean
language sql stable
as $$ select app.is_staff() and app.staff_rank(app.staff_role()) >= app.staff_rank(required) $$;

-- ============================================================================
-- Shared triggers
-- ============================================================================

create or replace function app.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================================
-- Database roles (§15.1 — insider misuse, broken access control)
--
--   app_owner : owns the schema, runs migrations. Not used by the application.
--   app_rw    : the application's connection role. Deliberately NOT the table
--               owner and deliberately NOT BYPASSRLS, so row-level policies
--               actually constrain it. This is the whole point.
--
-- Created IF NOT EXISTS so the migration is re-runnable on a shared cluster.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    create role app_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw nologin;
  end if;
end;
$$;

grant usage on schema public, app to app_rw;
grant execute on all functions in schema app to app_rw;
alter default privileges in schema app grant execute on functions to app_rw;

commit;

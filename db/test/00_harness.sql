-- ============================================================================
-- 00_harness.sql
-- A minimal assertion harness.
--
-- Deliberately not pgTAP. pgTAP means an extension that has to be present in
-- the CI postgres service container, on the developer's machine, and in any
-- future managed database used for testing. This harness is forty lines of
-- plain SQL that runs anywhere psql runs. When the suite outgrows it, swap in
-- pgTAP — the test bodies are written so that only the assertion calls change.
-- ============================================================================

create schema if not exists test;

create table if not exists test.result (
  id      serial primary key,
  name    text not null,
  passed  boolean not null,
  detail  text,
  ran_at  timestamptz not null default now()
);

-- Assert a condition. Records the result and fails loudly.
create or replace function test.ok(cond boolean, name text) returns text
language plpgsql as $$
begin
  insert into test.result (name, passed) values (name, coalesce(cond, false));
  if cond is not true then
    raise exception 'FAIL: %', name using errcode = 'assert_failure';
  end if;
  return '  pass  ' || name;
end;
$$;

create or replace function test.eq(a anyelement, b anyelement, name text) returns text
language plpgsql as $$
begin
  if a is not distinct from b then
    return test.ok(true, name);
  else
    insert into test.result (name, passed, detail)
      values (name, false, format('expected %L, got %L', b, a));
    raise exception 'FAIL: % (expected %L, got %L)', name, b, a
      using errcode = 'assert_failure';
  end if;
end;
$$;

-- Assert that a statement raises. Runs in a subtransaction so the failure does
-- not poison the surrounding test run.
create or replace function test.throws(stmt text, name text) returns text
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    return test.ok(true, name);
  end;
  insert into test.result (name, passed, detail)
    values (name, false, 'statement unexpectedly succeeded');
  raise exception 'FAIL: % — statement was expected to raise but succeeded', name
    using errcode = 'assert_failure';
end;
$$;

-- Assert a query returns exactly n rows, under whatever RLS context is active.
create or replace function test.rowcount(q text, n bigint, name text) returns text
language plpgsql as $$
declare c bigint;
begin
  execute format('select count(*) from (%s) _q', q) into c;
  return test.eq(c, n, name);
end;
$$;

-- Context switches. Session-scoped (false) so they persist across statements
-- in a psql script the way a request context would across a connection.
create or replace function test.as_staff(p_studio uuid, p_staff uuid, p_role text)
returns text language plpgsql as $$
begin
  perform set_config('app.actor_kind', 'staff', false);
  perform set_config('app.studio_id', p_studio::text, false);
  perform set_config('app.staff_id', p_staff::text, false);
  perform set_config('app.staff_role', p_role, false);
  perform set_config('app.guardian_id', '', false);
  return '';
end;
$$;

create or replace function test.as_guardian(p_guardian uuid)
returns text language plpgsql as $$
begin
  perform set_config('app.actor_kind', 'guardian', false);
  perform set_config('app.guardian_id', p_guardian::text, false);
  perform set_config('app.studio_id', '', false);
  perform set_config('app.staff_id', '', false);
  perform set_config('app.staff_role', '', false);
  return '';
end;
$$;

create or replace function test.as_system() returns text
language plpgsql as $$
begin
  perform set_config('app.actor_kind', 'system', false);
  perform set_config('app.studio_id', '', false);
  perform set_config('app.staff_id', '', false);
  perform set_config('app.guardian_id', '', false);
  perform set_config('app.staff_role', '', false);
  return '';
end;
$$;

create or replace function test.as_nobody() returns text
language plpgsql as $$
begin
  perform set_config('app.actor_kind', 'none', false);
  perform set_config('app.studio_id', '', false);
  perform set_config('app.staff_id', '', false);
  perform set_config('app.guardian_id', '', false);
  perform set_config('app.staff_role', '', false);
  return '';
end;
$$;

create or replace function test.summary() returns table (total bigint, passed bigint, failed bigint)
language sql as $$
  select count(*), count(*) filter (where passed), count(*) filter (where not passed)
    from test.result;
$$;

-- The suite runs as app_rw, so app_rw must be able to call the harness and
-- record results. Granted here rather than in a migration: the test schema
-- must never exist in production.
grant usage on schema test to app_rw;
grant execute on all functions in schema test to app_rw;
grant select, insert on test.result to app_rw;
grant usage, select on sequence test.result_id_seq to app_rw;

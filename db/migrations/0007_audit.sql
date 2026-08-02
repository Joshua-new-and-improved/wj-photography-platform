-- ============================================================================
-- 0007_audit.sql
-- Append-only, hash-chained audit log.
--
-- Architecture refs: §15.3. The first question after any incident is "who saw
-- what, when". Being able to answer it in ninety seconds is the difference
-- between a controlled disclosure and a crisis.
-- ============================================================================

begin;

create table audit_event (
  id           bigserial primary key,
  studio_id    uuid not null references studio(id) on delete restrict,
  -- Per-studio monotonic sequence. Makes a deleted row detectable as a gap,
  -- independently of the hash chain.
  seq          bigint not null,
  occurred_at  timestamptz not null default now(),

  actor_kind   text not null check (actor_kind in
                 ('staff','guardian','anonymous','system')),
  actor_id     uuid,
  -- Denormalised label so the log stays readable after the actor is deleted.
  actor_label  text,

  -- Dotted action names: 'claim.redeemed', 'gallery.viewed', 'asset.downloaded',
  -- 'price.changed', 'order.refunded', 'staff.role_changed', 'child.exported'.
  action       text not null,
  subject_type text not null,
  subject_id   uuid,

  ip           inet,
  user_agent   text,
  meta         jsonb not null default '{}'::jsonb,

  -- The chain. prev_hash of the first event in a studio is 32 zero bytes.
  prev_hash    bytea not null,
  hash         bytea not null,

  constraint audit_seq_unique unique (studio_id, seq)
);

create index audit_studio_time_idx on audit_event (studio_id, occurred_at desc);
create index audit_subject_idx on audit_event (subject_type, subject_id, occurred_at desc);
create index audit_actor_idx on audit_event (actor_kind, actor_id, occurred_at desc);
create index audit_action_idx on audit_event (studio_id, action, occurred_at desc);

-- ── Canonical serialisation ──────────────────────────────────────────────────
-- jsonb normalises key order, so its text form is deterministic — which is
-- what a hash chain requires. Building the canonical form in one place means
-- the verifier and the writer cannot drift apart.
create or replace function app.audit_canonical(e audit_event) returns text
language sql immutable
as $$
  select concat_ws('|',
    e.studio_id::text,
    e.seq::text,
    to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF'),
    e.actor_kind,
    coalesce(e.actor_id::text, ''),
    coalesce(e.actor_label, ''),
    e.action,
    e.subject_type,
    coalesce(e.subject_id::text, ''),
    coalesce(host(e.ip), ''),
    coalesce(e.user_agent, ''),
    e.meta::text
  );
$$;

-- ── Chain writer ─────────────────────────────────────────────────────────────
create or replace function app.audit_chain() returns trigger
language plpgsql
as $$
declare
  last_seq  bigint;
  last_hash bytea;
begin
  -- Serialise concurrent appends within a studio. Transaction-scoped, released
  -- automatically at commit or rollback. At this system's write volume the
  -- contention is negligible; the correctness it buys is not.
  perform pg_advisory_xact_lock(hashtext('audit:' || new.studio_id::text));

  select seq, hash into last_seq, last_hash
    from audit_event
   where studio_id = new.studio_id
   order by seq desc
   limit 1;

  new.seq       := coalesce(last_seq, 0) + 1;
  new.prev_hash := coalesce(last_hash, decode(repeat('00', 32), 'hex'));
  new.hash      := digest(new.prev_hash || convert_to(app.audit_canonical(new), 'UTF8'),
                          'sha256');
  return new;
end;
$$;

create trigger audit_event_chain
  before insert on audit_event
  for each row execute function app.audit_chain();

-- ── Append-only enforcement ──────────────────────────────────────────────────
-- Privilege revocation (§0008) is the primary control; these triggers are the
-- second layer, so that even a compromised owner connection leaves evidence
-- rather than silently rewriting history.
create or replace function app.audit_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_event is append-only: % is not permitted.', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_event_no_update
  before update on audit_event
  for each row execute function app.audit_immutable();

create trigger audit_event_no_delete
  before delete on audit_event
  for each row execute function app.audit_immutable();

-- ── Verification ─────────────────────────────────────────────────────────────
-- Walks the chain for a studio and reports the first break, if any. Run on a
-- schedule and after any suspected incident.
create or replace function app.audit_verify(p_studio uuid)
returns table (ok boolean, checked bigint, first_bad_seq bigint, reason text)
language plpgsql stable
as $$
declare
  r           audit_event;
  expect_prev bytea := decode(repeat('00', 32), 'hex');
  expect_seq  bigint := 1;
  n           bigint := 0;
begin
  for r in
    select * from audit_event where studio_id = p_studio order by seq
  loop
    if r.seq <> expect_seq then
      return query select false, n, r.seq,
        format('sequence gap: expected %s, found %s', expect_seq, r.seq);
      return;
    end if;

    if r.prev_hash <> expect_prev then
      return query select false, n, r.seq, 'prev_hash does not match the previous event'::text;
      return;
    end if;

    if r.hash <> digest(r.prev_hash || convert_to(app.audit_canonical(r), 'UTF8'), 'sha256') then
      return query select false, n, r.seq, 'row contents do not match its recorded hash'::text;
      return;
    end if;

    expect_prev := r.hash;
    expect_seq  := expect_seq + 1;
    n := n + 1;
  end loop;

  return query select true, n, null::bigint, null::text;
end;
$$;

commit;

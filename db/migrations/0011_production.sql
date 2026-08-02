-- ============================================================================
-- 0011_production.sql
--
-- Two corrections from the studio, and one safety change that follows from them.
--
-- 1. SCOPE. Version one is crèche and primary school portrait day only. The
--    sports and dance event work stays out until the school product is proven.
--    Migration 0010's browse mode is therefore built ahead of need. It is not
--    ripped out — the studio intends to come back to it — but a dormant
--    public-read code path is a security surface, so it is now bolted shut
--    behind a studio-level flag that defaults to off. Nothing can be read
--    anonymously until somebody deliberately turns it on.
--
-- 2. FULFILMENT. Assumption A8 said prints are outsourced to a lab. Migration
--    0010 then said they are printed on site at events. Both are wrong. The
--    studio prints IN HOUSE, AT THE OFFICE, AFTER the order deadline, and
--    delivers to the school for distribution. That is a third model and it is
--    the one that shapes the admin console:
--
--      deadline closes → orders batched → printed at the office →
--      packed by class → delivered to the school → school hands out
--
--    So there is no lab export and no onsite queue. There is a production
--    queue the photographer works through, and a packing manifest ordered the
--    way the school secretary will sort the boxes (§12.5).
-- ============================================================================

begin;

-- ── 1. Bolt the dormant public path shut ─────────────────────────────────────
alter table studio
  add column event_mode_enabled boolean not null default false;

comment on column studio.event_mode_enabled is
  'Master switch for browse-mode (public event) galleries. Off until the school product is proven. While off, no anonymous read path exists at all.';

drop policy browse_public_shoots on shoot;
drop policy browse_public_assets on asset;
drop policy browse_public_variants on asset_variant;

-- The obvious policy would read the flag off `studio` in a subquery. That does
-- not work: the subquery is itself subject to studio's row-level policies, and
-- an anonymous visitor cannot see the studio row, so the whole test silently
-- evaluates false. Policies cannot reach around other policies.
--
-- Same answer as for asset: denormalise, maintain by trigger, and keep the
-- policy a single-column test.
alter table shoot add column is_public boolean not null default false;

create or replace function app.sync_shoot_publicity() returns trigger
language plpgsql as $$
declare enabled boolean;
begin
  select event_mode_enabled into enabled from studio where id = new.studio_id;
  new.is_public :=
    coalesce(enabled, false)
    and new.access_mode = 'browse' and new.status = 'open'
    and (new.gallery_opens_at is null or new.gallery_opens_at <= now());
  return new;
end;
$$;

create trigger shoot_publicity_self
  before insert or update on shoot
  for each row execute function app.sync_shoot_publicity();

create policy browse_public_shoots on shoot
  for select using (is_public);

-- asset.is_public is maintained by trigger, so the flag is folded into the
-- trigger rather than the policy — keeping the hot-path policy a single-column
-- test, which is why it was denormalised in the first place.
create policy browse_public_assets on asset
  for select using (is_public);

create policy browse_public_variants on asset_variant
  for select using (
    kind in ('thumb','preview','proof') and watermarked
    and exists (select 1 from asset a
                 where a.id = asset_variant.asset_id and a.is_public)
  );

create or replace function app.sync_asset_publicity() returns trigger
language plpgsql as $$
declare mode text; st text; opens timestamptz; enabled boolean;
begin
  select s.access_mode, s.status, s.gallery_opens_at, stu.event_mode_enabled
    into mode, st, opens, enabled
    from shoot s join studio stu on stu.id = s.studio_id
   where s.id = new.shoot_id;

  new.is_public :=
    coalesce(enabled, false)
    and mode = 'browse' and st = 'open'
    and (opens is null or opens <= now())
    and new.status = 'ready' and not new.is_slate;
  return new;
end;
$$;

create or replace function app.propagate_shoot_publicity() returns trigger
language plpgsql as $$
declare enabled boolean;
begin
  if new.access_mode is distinct from old.access_mode
     or new.status is distinct from old.status
     or new.gallery_opens_at is distinct from old.gallery_opens_at then
    select event_mode_enabled into enabled from studio where id = new.studio_id;
    update asset
       set is_public = (
             coalesce(enabled, false)
             and new.access_mode = 'browse' and new.status = 'open'
             and (new.gallery_opens_at is null or new.gallery_opens_at <= now())
             and status = 'ready' and not is_slate)
     where shoot_id = new.id;
  end if;
  return new;
end;
$$;

-- Flipping the master switch has to propagate to everything already stored,
-- in both directions. Turning it off must actually close the door.
create or replace function app.propagate_studio_event_mode() returns trigger
language plpgsql as $$
begin
  if new.event_mode_enabled is distinct from old.event_mode_enabled then
    update shoot
       set is_public = (
             new.event_mode_enabled
             and access_mode = 'browse' and status = 'open'
             and (gallery_opens_at is null or gallery_opens_at <= now()))
     where studio_id = new.id;

    update asset a
       set is_public = (
             new.event_mode_enabled
             and s.access_mode = 'browse' and s.status = 'open'
             and (s.gallery_opens_at is null or s.gallery_opens_at <= now())
             and a.status = 'ready' and not a.is_slate)
      from shoot s
     where s.id = a.shoot_id and a.studio_id = new.id;
  end if;
  return new;
end;
$$;

create trigger studio_event_mode_switch
  after update on studio
  for each row execute function app.propagate_studio_event_mode();

-- ── 2. Replace the onsite model with in-house production ─────────────────────
alter table "order" drop column print_queue_no;
alter table "order" drop column collected_at;
alter table "order" drop constraint order_channel_check;
alter table "order"
  add constraint order_channel_check
    check (channel in ('online','manual'));

comment on column "order".channel is
  'online = parent checked out on the site; manual = studio captured a paper or cash order on the parent''s behalf (§2.11).';

-- A run of printing at the office. The photographer works through these after
-- the order deadline closes, not one order at a time.
create table print_batch (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  shoot_id     uuid not null references shoot(id) on delete restrict,
  label        text not null,                 -- 'Louis Leipoldt — Graad R–3'
  status       text not null default 'queued' check (status in
                 ('queued','printing','printed','packed','delivered','cancelled')),
  created_by   uuid not null references staff_user(id),
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,
  notes        text
);

create index print_batch_shoot_idx on print_batch (studio_id, shoot_id, created_at desc);
create index print_batch_open_idx on print_batch (studio_id, status)
  where status in ('queued','printing','printed');

-- One physical print to produce. Granular rather than per-order, because a
-- single bad print must not reset the whole order — it becomes one reprint
-- job, and the rest of the order stays packed.
create table print_job (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  print_batch_id uuid references print_batch(id) on delete set null,
  order_id      uuid not null references "order"(id) on delete cascade,
  order_line_id uuid not null references order_line(id) on delete cascade,
  child_id      uuid not null references child(id) on delete restrict,
  asset_id      uuid not null references asset(id) on delete restrict,

  size_label    text not null,
  finish        text,
  quantity      int not null check (quantity > 0),
  -- The exact rectangle the parent chose, as fractions of the original, so the
  -- print is reproducible from the archive years later (§2.10).
  crop          jsonb not null,

  status        text not null default 'queued' check (status in
                  ('queued','printed','reprint_needed','superseded','packed')),
  reprint_of    uuid references print_job(id),
  reprint_reason text,
  printed_at    timestamptz,
  printed_by    uuid references staff_user(id),
  created_at    timestamptz not null default now(),

  constraint print_job_reprint_has_reason check (
    reprint_of is null or reprint_reason is not null
  )
);

create index print_job_batch_idx on print_job (print_batch_id, status);
create index print_job_order_idx on print_job (order_id);
-- The packing manifest sorts by class, because that is how the boxes get
-- sorted for the school office. Sorting by order number would make the
-- secretary's day considerably worse (§12.5).
create index print_job_pack_idx on print_job (studio_id, child_id) where status = 'packed';

-- ── 3. Delivery back to the school ───────────────────────────────────────────
create table delivery (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  shoot_id     uuid not null references shoot(id) on delete restrict,
  school_id    uuid not null references school(id) on delete restrict,
  scheduled_for date,
  delivered_at timestamptz,
  received_by  text,                  -- name of the person at the school office
  order_count  int not null default 0,
  notes        text,
  status       text not null default 'planned' check (status in
                 ('planned','in_transit','delivered','partially_delivered')),
  created_at   timestamptz not null default now()
);

create index delivery_shoot_idx on delivery (studio_id, shoot_id);

alter table "order" add column delivery_id uuid references delivery(id) on delete set null;
create index order_delivery_idx on "order" (delivery_id) where delivery_id is not null;

-- A print job may not be produced for an order that has not been paid for,
-- unless a staff member recorded an offline payment. Same rule as the
-- fulfilment gate in 0006, enforced at the point where paper and ink are
-- actually consumed.
create or replace function app.enforce_print_payment() returns trigger
language plpgsql as $$
declare pay text; off text; num text;
begin
  select payment_status, offline_method, order_number
    into pay, off, num
    from "order" where id = new.order_id;
  if pay <> 'settled' and off is null then
    raise exception
      'Cannot queue a print for order % — payment_status is "%" and no offline payment is recorded.',
      num, pay
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger print_job_payment_gate
  before insert on print_job
  for each row execute function app.enforce_print_payment();

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['print_batch','print_job','delivery'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format($p$
      create policy staff_tenant_scope on public.%I
        for all
        using (app.is_staff() and studio_id = app.studio_id())
        with check (app.is_staff() and studio_id = app.studio_id())
    $p$, t);
  end loop;
end;
$$;

-- Production is the photographer's own work. Assistants tag; they do not run
-- the printer or sign off deliveries (§6.5). Guardians have no visibility:
-- there is deliberately no guardian policy on any of these tables.
create policy print_min_photographer on print_batch as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));
create policy printjob_min_photographer on print_job as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));
create policy delivery_min_photographer on delivery as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));

commit;

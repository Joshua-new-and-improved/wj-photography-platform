-- ============================================================================
-- 0013_delivery_and_email.sql
--
-- Three changes, all from the studio.
--
-- 1. DIGITAL AND PHYSICAL DELIVER ON DIFFERENT CLOCKS. A digital image should
--    reach the parent the moment payment settles. A print reaches them weeks
--    later, on a date the studio picks. Until now `order.fulfilment_status` was
--    a single track, which cannot express "the download is delivered and the
--    prints are still queued" — the normal state of most orders for most of
--    their life.
--
-- 2. EVERYTHING THE STUDIO MIGHT WANT TO CHANGE MUST BE DATA. Prices and
--    packages already were. School names, dispatch dates, email copy, deadlines
--    and reminder timing were not, or were only half-way there.
--
-- 3. EMAIL IS AUTOMATED, SO IT NEEDS AN OUTBOX. Not fire-and-forget: a queued
--    row with a status, an attempt count, an idempotency key and a bounce
--    record. Sending email from inside a request handler loses messages the
--    first time the provider has a bad afternoon.
-- ============================================================================

begin;

-- ── 1. Two delivery tracks ───────────────────────────────────────────────────

-- Which clock does this line run on? Derived from the product at order time and
-- then frozen, like every other order-line fact (§11.1) — reclassifying a
-- product later must not change what an old order promised.
alter table order_line
  add column fulfilment_kind text not null default 'physical'
    check (fulfilment_kind in ('digital','physical'));

-- The existing fulfilment_status column keeps its meaning: it is the PHYSICAL
-- track. Renaming it would churn every query for no gain, so it is documented
-- instead and the digital track gets its own column.
comment on column "order".fulfilment_status is
  'Physical items only: printing, packing, delivery to the school. Digital delivery runs on digital_status.';

alter table "order"
  add column digital_status text not null default 'none'
    check (digital_status in ('none','pending','delivered','failed','revoked')),
  add column digital_delivered_at timestamptz,
  -- The date the studio chooses for physical items to leave the office.
  -- Null means "not scheduled yet", which is what the admin console shows as
  -- an outstanding decision rather than a silent default.
  add column physical_dispatch_at timestamptz;

create index order_digital_pending_idx on "order" (studio_id, payment_status)
  where digital_status = 'pending';

-- Digital goods are released on payment and not before. Same rule as the
-- physical gate in 0006, at the point where the file actually becomes
-- downloadable.
create or replace function app.enforce_digital_gate() returns trigger
language plpgsql as $$
begin
  if new.digital_status = 'delivered'
     and new.payment_status <> 'settled'
     and new.offline_method is null then
    raise exception
      'Order % cannot release digital goods while payment_status is "%".',
      new.order_number, new.payment_status
      using errcode = 'check_violation';
  end if;
  if new.digital_status = 'delivered' and new.digital_delivered_at is null then
    new.digital_delivered_at := now();
  end if;
  return new;
end;
$$;

create trigger order_digital_gate
  before insert or update on "order"
  for each row execute function app.enforce_digital_gate();

-- When does a shoot's digital content unlock? The studio's default is on
-- payment, but a school that wants nothing released until every parent has
-- ordered can be accommodated without a code change.
alter table shoot
  add column digital_release text not null default 'on_payment'
    check (digital_release in ('on_payment','on_deadline','manual'));

-- ── 2. Customisation ─────────────────────────────────────────────────────────

-- A general settings store, so a preference the studio thinks of next month is
-- a row rather than a migration. Explicit columns stay for anything with a
-- constraint worth enforcing; this is for the long tail.
create table studio_setting (
  studio_id  uuid not null references studio(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_by uuid references staff_user(id),
  updated_at timestamptz not null default now(),
  primary key (studio_id, key)
);

comment on table studio_setting is
  'Long-tail studio preferences: reminder timing, default grace hours, currency display, sender names. Anything with a real invariant gets a typed column instead.';

-- Schools change their trading name, their contact, and how they want to be
-- addressed on a parent-facing page. All editable.
alter table school
  add column display_name text,       -- overrides name on parent-facing pages
  add column logo_storage_key text,
  add column notes text;

comment on column school.display_name is
  'What parents see. Falls back to name. Lets the studio write "Louis Leipoldt Primary" where the legal name is something longer.';

-- ── 3. Email ─────────────────────────────────────────────────────────────────

-- Editable copy. The studio rewrites a thank-you message far more often than it
-- changes a price, and it must not need a developer.
create table email_template (
  id         uuid primary key default app.uuidv7(),
  studio_id  uuid not null references studio(id) on delete cascade,
  key        text not null,          -- 'order.paid', 'digital.ready', 'reminder.final_48h'
  subject    text not null,
  body_md    text not null,
  -- Version bumps on every edit, and outbound messages record which version
  -- they used. A parent who quotes an email back must be answerable exactly.
  version    int not null default 1,
  active     boolean not null default true,
  updated_by uuid references staff_user(id),
  updated_at timestamptz not null default now(),
  constraint email_template_key_unique unique (studio_id, key)
);

create table email_message (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,

  to_email      citext not null,
  to_name       text,
  guardian_id   uuid references guardian(id) on delete set null,
  order_id      uuid references "order"(id) on delete set null,
  child_id      uuid references child(id) on delete set null,
  shoot_id      uuid references shoot(id) on delete set null,

  template_key  text not null,
  template_version int,
  subject       text not null,
  body_html     text not null,
  body_text     text not null,

  -- Attachments are references, never bytes: a digital order is delivered as
  -- expiring signed links (§8.4), not as 40 MB of originals in an inbox that
  -- will bounce and cannot be revoked after a refund.
  attachment_grants uuid[] not null default '{}',

  status        text not null default 'queued' check (status in
                  ('queued','sending','sent','bounced','failed','suppressed')),
  scheduled_for timestamptz not null default now(),
  attempts      int not null default 0,
  last_error    text,
  provider_message_id text,
  sent_at       timestamptz,
  bounced_at    timestamptz,
  bounce_type   text check (bounce_type in ('hard','soft','complaint')),

  -- The whole point of an outbox. A retried job, a duplicated webhook or a
  -- double-clicked button must not produce two thank-you emails.
  idempotency_key text not null,
  created_at    timestamptz not null default now(),

  constraint email_idempotent unique (studio_id, idempotency_key)
);

create index email_due_idx on email_message (scheduled_for)
  where status = 'queued';
create index email_guardian_idx on email_message (guardian_id, created_at desc);
create index email_order_idx on email_message (order_id);

-- Address health, so the studio can see and fix a wrong address rather than
-- silently failing to deliver someone's photographs.
alter table guardian
  add column email_bounced_at timestamptz,
  add column email_bounce_type text check (email_bounce_type in ('hard','soft','complaint')),
  add column email_corrected_from citext;

comment on column guardian.email_corrected_from is
  'Set when the parent accepted a suggested correction at checkout (gmial.com to gmail.com). Kept so a genuinely unusual address is never "corrected" twice.';

-- A hard bounce means the address is wrong. Continuing to queue mail to it
-- damages sender reputation and, more importantly, means nobody notices the
-- parent never got their photographs.
create or replace function app.suppress_on_hard_bounce() returns trigger
language plpgsql as $$
begin
  if new.bounce_type = 'hard' and (old.bounce_type is distinct from 'hard') then
    update guardian
       set email_bounced_at = coalesce(new.bounced_at, now()),
           email_bounce_type = 'hard'
     where id = new.guardian_id;

    update email_message
       set status = 'suppressed',
           last_error = 'Suppressed: address hard-bounced'
     where guardian_id = new.guardian_id
       and status = 'queued';
  end if;
  return new;
end;
$$;

create trigger email_hard_bounce
  after update on email_message
  for each row execute function app.suppress_on_hard_bounce();

-- ── RLS ──────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['studio_setting','email_template','email_message'] loop
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

-- Editing settings and email copy is an admin action; a photographer runs
-- shoots but does not rewrite what goes out under the studio's name.
create policy settings_admin_write on studio_setting as restrictive
  for all using (not app.is_staff() or app.staff_at_least('admin'));
create policy template_admin_write on email_template as restrictive
  for all using (not app.is_staff() or app.staff_at_least('admin'));
create policy email_min_photographer on email_message as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));

-- The outbox worker runs without a staff session.
create policy system_email_outbox on email_message
  for all using (app.actor_kind() = 'system')
  with check (app.actor_kind() = 'system');

-- Staff could read guardian records but never update them, which meant the
-- bounce trigger silently updated zero rows — RLS applies inside triggers too,
-- and a policy-less UPDATE fails by writing nothing rather than by raising.
--
-- Correcting a parent's address is also a real support task now that the studio
-- wants bad addresses caught, so this policy is needed on its own merits.
create policy staff_update_guardian on guardian
  for update using (app.staff_at_least('photographer'))
  with check (app.staff_at_least('photographer'));

create policy system_update_guardian on guardian
  for update using (app.actor_kind() = 'system')
  with check (app.actor_kind() = 'system');

-- A parent may see the mail sent to them, so "resend my download link" is
-- self-service rather than a phone call.
create policy guardian_own_email on email_message
  for select using (app.is_guardian() and guardian_id = app.guardian_id());

commit;

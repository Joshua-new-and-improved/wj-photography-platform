-- ============================================================================
-- 0006_commerce.sql
-- Catalogue, price versioning, packages, carts, orders, payments, fulfilment.
--
-- Architecture refs: §11 (catalogue & pricing), §12 (ordering & payments).
-- All money is integer cents. Never floating point.
-- ============================================================================

begin;

-- ── Print sizes as data (§11.5) ──────────────────────────────────────────────
-- Millimetres stored, aspect derived. Adding a size is a data operation, and
-- the crop logic and minimum-resolution warning follow automatically.
create table print_size (
  id         uuid primary key default app.uuidv7(),
  studio_id  uuid not null references studio(id) on delete restrict,
  label      text not null,
  width_mm   numeric(8,2) not null check (width_mm > 0),
  height_mm  numeric(8,2) not null check (height_mm > 0),
  aspect     numeric(10,6) generated always as (
               greatest(width_mm, height_mm) / least(width_mm, height_mm)
             ) stored,
  min_dpi    int not null default 300 check (min_dpi > 0),
  bleed_mm   numeric(6,2) not null default 0,
  active     boolean not null default true,
  sort_order int not null default 0,
  constraint print_size_label_unique unique (studio_id, label)
);

-- ── Products ─────────────────────────────────────────────────────────────────
create table product (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  sku          text not null,
  -- i18n from Phase 1, not "future" (§2.12). {"af": "...", "en": "..."}
  name_i18n    jsonb not null,
  description_i18n jsonb not null default '{}'::jsonb,
  kind         text not null check (kind in
                 ('print','digital_single','digital_gallery','merch')),
  category     text,
  hero_storage_key text,
  -- How many images the buyer must choose for one unit of this product.
  image_slots  int not null default 1 check (image_slots >= 0),
  active       boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint product_sku_unique unique (studio_id, sku),
  constraint product_name_has_locales check (
    name_i18n ? 'af' and name_i18n ? 'en'
  )
);

create trigger product_touch before update on product
  for each row execute function app.touch_updated_at();

-- A print product is offered in one or more sizes.
create table product_variant (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  product_id    uuid not null references product(id) on delete cascade,
  print_size_id uuid references print_size(id) on delete restrict,
  label         text,
  finish        text,                       -- 'gloss', 'matt', 'lustre'
  active        boolean not null default true,
  sort_order    int not null default 0,
  constraint product_variant_unique unique (product_id, print_size_id, finish)
);

-- ── Price versioning (§11.1) ─────────────────────────────────────────────────
-- If the Silver package price changes on Tuesday, Monday's orders keep
-- Monday's price. Forever. Two mechanisms: effective-dated price lists here,
-- and order-line snapshots below. Both are required.
create table price_list (
  id             uuid primary key default app.uuidv7(),
  studio_id      uuid not null references studio(id) on delete restrict,
  school_id      uuid references school(id) on delete cascade,  -- null = all schools
  name           text not null,
  effective_from timestamptz not null,
  effective_to   timestamptz,
  status         text not null default 'draft'
                   check (status in ('draft','published','superseded')),
  created_at     timestamptz not null default now(),
  constraint price_list_dates check (effective_to is null or effective_to > effective_from)
);

create index price_list_active_idx on price_list (studio_id, school_id, effective_from desc)
  where status = 'published';

create table price (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  price_list_id uuid not null references price_list(id) on delete cascade,
  product_id    uuid references product(id) on delete cascade,
  variant_id    uuid references product_variant(id) on delete cascade,
  package_id    uuid,                       -- FK added after package exists
  -- VAT-inclusive, because the buyers are consumers and a checkout that adds
  -- 15% at the last step reads as a trick (§11.3).
  amount_cents  bigint not null check (amount_cents >= 0),
  currency      char(3) not null default 'ZAR',
  vat_rate_bps  int not null default 1500,
  constraint price_targets_exactly_one check (
    (product_id is not null)::int + (package_id is not null)::int = 1
  )
);

create index price_lookup_idx on price (price_list_id, product_id, variant_id);

-- ── Packages (§11.2) ─────────────────────────────────────────────────────────
create table package (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  -- The quiet addition: different packages and pricing at a fee-paying
  -- suburban primary and at a crèche in a different market, without
  -- duplicating the catalogue. One nullable column now, painful to add later.
  school_id    uuid references school(id) on delete cascade,
  name_i18n    jsonb not null,
  description_i18n jsonb not null default '{}'::jsonb,
  hero_storage_key text,
  active       boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint package_name_has_locales check (name_i18n ? 'af' and name_i18n ? 'en')
);

create trigger package_touch before update on package
  for each row execute function app.touch_updated_at();

alter table price add constraint price_package_fk
  foreign key (package_id) references package(id) on delete cascade;

create table package_item (
  id          uuid primary key default app.uuidv7(),
  studio_id   uuid not null references studio(id) on delete restrict,
  package_id  uuid not null references package(id) on delete cascade,
  product_id  uuid not null references product(id) on delete restrict,
  variant_id  uuid references product_variant(id) on delete restrict,
  quantity    int not null check (quantity > 0),
  -- A real operational distinction that drives the checkout UI: five prints of
  -- the same photograph is a different product from five the parent chooses
  -- individually (§11.2).
  image_choice text not null default 'per_slot' check (image_choice in
                 ('per_slot','same_for_all','studio_choice')),
  sort_order  int not null default 0
);

create index package_item_package_idx on package_item (package_id, sort_order);

-- ── Cart (§9) ────────────────────────────────────────────────────────────────
-- Server-authoritative. Repriced from the active price list at checkout.
create table cart (
  id          uuid primary key default app.uuidv7(),
  studio_id   uuid not null references studio(id) on delete restrict,
  shoot_id    uuid not null references shoot(id) on delete cascade,
  -- Exactly one of these: an anonymous preview session (§6.3) or a signed-in
  -- guardian. The cart survives the transition from one to the other.
  preview_session_id uuid references preview_session(id) on delete cascade,
  guardian_id uuid references guardian(id) on delete cascade,
  status      text not null default 'open'
                check (status in ('open','converted','abandoned')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint cart_has_one_owner check (
    (preview_session_id is not null)::int + (guardian_id is not null)::int >= 1
  )
);

create trigger cart_touch before update on cart
  for each row execute function app.touch_updated_at();

create table cart_item (
  id          uuid primary key default app.uuidv7(),
  studio_id   uuid not null references studio(id) on delete restrict,
  cart_id     uuid not null references cart(id) on delete cascade,
  child_id    uuid not null references child(id) on delete restrict,
  product_id  uuid references product(id) on delete restrict,
  variant_id  uuid references product_variant(id) on delete restrict,
  package_id  uuid references package(id) on delete restrict,
  quantity    int not null default 1 check (quantity > 0),
  -- Chosen photographs, and per-print crop rectangles (§2.10). Stored as
  -- fractions of the original so they survive any future re-derivation.
  --   [{"asset_id":"…","slot":0,"crop":{"x":0.05,"y":0.0,"w":0.9,"h":0.95}}]
  selections  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  constraint cart_item_targets_exactly_one check (
    (product_id is not null)::int + (package_id is not null)::int = 1
  )
);

create index cart_item_cart_idx on cart_item (cart_id);

-- ── Orders (§12.1) ───────────────────────────────────────────────────────────
-- Two independent state machines, not one. An order can be paid but not
-- printed, printed but refunded, or unpaid but cancelled. A single enum forces
-- impossible transitions and makes reconciliation ambiguous, which is exactly
-- where money gets lost.
create table "order" (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  school_id     uuid not null references school(id) on delete restrict,
  shoot_id      uuid not null references shoot(id) on delete restrict,
  guardian_id   uuid not null references guardian(id) on delete restrict,
  -- Crockford base32, grouped. Survives being read aloud over the phone (§5.2).
  order_number  text not null unique,

  currency      char(3) not null default 'ZAR',
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  vat_cents      bigint not null default 0 check (vat_cents >= 0),
  delivery_cents bigint not null default 0 check (delivery_cents >= 0),
  total_cents    bigint not null check (total_cents >= 0),
  -- Commission owed to the school, computed at order time from the rate then
  -- in force (§2.14).
  commission_cents bigint not null default 0 check (commission_cents >= 0),

  payment_status text not null default 'pending' check (payment_status in
                   ('pending','initiated','authorised','settled','failed',
                    'abandoned','refunded','partially_refunded')),
  fulfilment_status text not null default 'not_started' check (fulfilment_status in
                   ('not_started','queued','in_production','printed',
                    'ready_for_collection','dispatched','completed','cancelled')),

  delivery_method text not null default 'school_collection'
                   check (delivery_method in ('school_collection','courier')),
  delivery_address text,

  -- Offline and cash orders are first-class (§2.11). Without this the
  -- photographer keeps a parallel paper system and the statistics are fiction.
  placed_by_staff_id uuid references staff_user(id),
  offline_method  text check (offline_method in ('cash','manual_eft','school_collected')),
  offline_ref     text,

  placed_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint order_total_adds_up check (
    total_cents = subtotal_cents + delivery_cents
  ),
  constraint order_offline_needs_ref check (
    offline_method is null or offline_ref is not null
  )
);

create index order_shoot_idx on "order" (studio_id, shoot_id, placed_at desc);
create index order_guardian_idx on "order" (guardian_id, placed_at desc);
create index order_work_queue_idx on "order" (studio_id, fulfilment_status)
  where fulfilment_status not in ('completed','cancelled');

create trigger order_touch before update on "order"
  for each row execute function app.touch_updated_at();

-- Fulfilment may not start unless payment settled, or a staff member has
-- explicitly overridden — which is the cash-at-the-school-office case (§12.1).
create or replace function app.enforce_fulfilment_gate() returns trigger
language plpgsql
as $$
begin
  if new.fulfilment_status <> 'not_started'
     and new.fulfilment_status <> 'cancelled'
     and new.payment_status <> 'settled'
     and new.offline_method is null then
    raise exception
      'Order % cannot enter fulfilment state "%" while payment_status is "%" and no offline payment is recorded.',
      new.order_number, new.fulfilment_status, new.payment_status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger order_fulfilment_gate
  before insert or update on "order"
  for each row execute function app.enforce_fulfilment_gate();

create table order_line (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  order_id     uuid not null references "order"(id) on delete cascade,
  child_id     uuid not null references child(id) on delete restrict,
  line_no      int not null,
  kind         text not null check (kind in ('product','package','delivery','discount')),
  quantity     int not null check (quantity > 0),
  unit_cents   bigint not null,
  line_total_cents bigint not null,
  vat_rate_bps int not null,
  vat_cents    bigint not null default 0,

  -- The order-line snapshot (§11.1). The full product or package definition as
  -- it stood at purchase: name, included items, quantities, price, VAT rate.
  -- NEVER render an historical order by joining to the live catalogue.
  snapshot     jsonb not null,
  selections   jsonb not null default '[]'::jsonb,

  constraint order_line_no_unique unique (order_id, line_no),
  constraint order_line_total_correct check (
    line_total_cents = unit_cents * quantity
  )
);

create index order_line_order_idx on order_line (order_id, line_no);
create index order_line_child_idx on order_line (child_id);

-- ── Payments (§12.2) ─────────────────────────────────────────────────────────
create table payment (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  order_id     uuid not null references "order"(id) on delete restrict,
  provider     text not null,                -- 'payfast', 'ozow', 'offline'
  provider_ref text,
  method       text,                         -- 'card', 'instant_eft', 'cash'
  amount_cents bigint not null,
  currency     char(3) not null default 'ZAR',
  status       text not null check (status in
                 ('initiated','authorised','settled','failed','refunded')),
  created_at   timestamptz not null default now(),
  settled_at   timestamptz,
  constraint payment_provider_ref_unique unique (provider, provider_ref)
);

create index payment_order_idx on payment (order_id, created_at desc);

-- Webhooks are at-least-once. Storing the provider's event id with a unique
-- constraint makes duplicate delivery arithmetically harmless (§12.2).
create table payment_event (
  id            bigserial primary key,
  provider      text not null,
  provider_event_id text not null,
  order_id      uuid references "order"(id) on delete set null,
  signature_valid boolean not null,
  source_ip     inet,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  processing_error text,
  constraint payment_event_idempotent unique (provider, provider_event_id)
);

create index payment_event_unprocessed_idx on payment_event (received_at)
  where processed_at is null;

-- ── Digital delivery (§8.4, §12.4) ───────────────────────────────────────────
create table download_grant (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  order_id     uuid not null references "order"(id) on delete cascade,
  guardian_id  uuid not null references guardian(id) on delete cascade,
  asset_id     uuid not null references asset(id) on delete restrict,
  max_downloads int not null default 10 check (max_downloads > 0),
  downloads    int not null default 0 check (downloads >= 0),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,                  -- set on refund (§12.4)
  created_at   timestamptz not null default now(),
  constraint download_grant_unique unique (order_id, asset_id, guardian_id),
  constraint download_grant_within_limit check (downloads <= max_downloads)
);

create index download_grant_guardian_idx on download_grant (guardian_id)
  where revoked_at is null;

commit;

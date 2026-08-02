-- ============================================================================
-- 0002_tenancy.sql
-- The studio (tenant), its staff, and staff sessions.
--
-- Architecture refs: §5.1, §6.5, §11.4.
-- ============================================================================

begin;

-- ── Studio: the tenant (§5.1) ────────────────────────────────────────────────
-- Today this table holds exactly one row. It exists anyway because carrying
-- studio_id from day one is nearly free, and retrofitting it is not.
create table studio (
  id              uuid primary key default app.uuidv7(),
  name            text not null,
  trading_name    text,
  -- null vat_number means not VAT-registered. Must cleanly suppress VAT lines,
  -- VAT wording, and the tax-invoice breakdown without breaking history when
  -- the studio later registers (§11.4).
  vat_number      text,
  vat_rate_bps    int  not null default 1500
                    check (vat_rate_bps between 0 and 5000),
  -- Turnover monitor for the R2.3m compulsory registration threshold (§11.4).
  -- Stored in cents to stay consistent with all other money in the schema.
  vat_threshold_cents bigint not null default 230000000,
  default_locale  text not null default 'af' check (default_locale in ('af','en')),
  currency        char(3) not null default 'ZAR',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger studio_touch before update on studio
  for each row execute function app.touch_updated_at();

-- ── Staff (§6.5) ─────────────────────────────────────────────────────────────
create table staff_user (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  email         citext not null,
  full_name     text not null,
  role          text not null check (role in
                  ('owner','admin','photographer','assistant','viewer')),
  status        text not null default 'invited'
                  check (status in ('invited','active','suspended')),
  locale        text not null default 'en' check (locale in ('af','en')),
  -- MFA is mandatory for owner and admin. Enforced by a check constraint so it
  -- cannot be bypassed by a code path that forgot (§6.5).
  mfa_secret_enc bytea,
  mfa_enabled   boolean not null default false,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint staff_email_unique_per_studio unique (studio_id, email),
  constraint staff_privileged_requires_mfa check (
    status <> 'active'
    or role not in ('owner','admin')
    or mfa_enabled
  )
);

create index staff_user_studio_idx on staff_user (studio_id) where status = 'active';

create trigger staff_user_touch before update on staff_user
  for each row execute function app.touch_updated_at();

-- Exactly one owner per studio. Losing the owner locks you out; having two
-- makes accountability ambiguous.
create unique index staff_user_one_owner_per_studio
  on staff_user (studio_id) where role = 'owner' and status <> 'suspended';

-- ── Staff sessions ───────────────────────────────────────────────────────────
-- Opaque server-side sessions rather than self-contained JWTs, because
-- revocation has to be immediate: a suspended assistant must lose access on
-- the next request, not when a token happens to expire.
create table staff_session (
  id           uuid primary key default app.uuidv7(),
  staff_id     uuid not null references staff_user(id) on delete cascade,
  token_hash   bytea not null unique,      -- sha256 of the cookie value
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index staff_session_staff_idx on staff_session (staff_id)
  where revoked_at is null;
create index staff_session_expiry_idx on staff_session (expires_at)
  where revoked_at is null;

commit;

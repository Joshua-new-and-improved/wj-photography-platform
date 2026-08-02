-- ============================================================================
-- 0004_children_and_access.sql
-- Children, enrolment, the suppression register, guardians, the claim model,
-- and consent records.
--
-- Architecture refs: §2.4 (suppression), §3.3 (consent), §6.2 (claim model).
-- This is the most safety-critical migration in the project.
-- ============================================================================

begin;

-- ── Child ────────────────────────────────────────────────────────────────────
create table child (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  school_id    uuid not null references school(id) on delete restrict,
  public_ref   text not null unique default app.public_ref(),

  first_name   text not null,
  last_name    text not null,
  -- The school's own learner number, when supplied with the class list (§7.3).
  external_ref text,

  -- The suppression register (§2.4). A first-class, query-enforced field —
  -- not a note in a free-text box, because the failure mode is not
  -- embarrassing, it is dangerous.
  --   none            : normal
  --   no_photography  : must not be photographed at all
  --   no_publication  : may be photographed, must not be shown or sold
  --   quarantined     : assets exist and are locked pending destruction
  suppression_status text not null default 'none' check (suppression_status in
                       ('none','no_photography','no_publication','quarantined')),
  -- Restricted visibility: owner/admin only. Reasons here are often sensitive
  -- (protection orders, foster placements) and are encrypted at the app layer.
  suppression_reason_enc bytea,
  suppression_set_at     timestamptz,
  suppression_set_by     uuid references staff_user(id),

  status       text not null default 'active'
                 check (status in ('active','left_school','merged','deleted')),
  merged_into  uuid references child(id),

  search_vector tsvector generated always as (
    to_tsvector('simple',
      app.immutable_unaccent(coalesce(first_name,'') || ' ' || coalesce(last_name,'')))
  ) stored,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint child_suppression_has_provenance check (
    suppression_status = 'none' or suppression_set_at is not null
  )
);

-- §13: fuzzy matching matters more than exact matching here — Zané, Zane and
-- Zanè all have to find the same child.
create index child_search_idx on child using gin (search_vector);
create index child_name_trgm_idx on child using gin
  ((app.immutable_unaccent(first_name || ' ' || last_name)) gin_trgm_ops);
create index child_school_idx on child (studio_id, school_id)
  where status = 'active' and suppression_status = 'none';
create index child_suppressed_idx on child (studio_id, suppression_status)
  where suppression_status <> 'none';
create unique index child_external_ref_idx on child (school_id, external_ref)
  where external_ref is not null;

create trigger child_touch before update on child
  for each row execute function app.touch_updated_at();

-- ── Enrolment ────────────────────────────────────────────────────────────────
-- Keyed on academic year because children change classes annually and last
-- year's gallery must still resolve to last year's class (§5.4).
create table enrolment (
  studio_id      uuid not null references studio(id) on delete restrict,
  child_id       uuid not null references child(id) on delete cascade,
  class_group_id uuid not null references class_group(id) on delete cascade,
  academic_year  int  not null,
  created_at     timestamptz not null default now(),
  primary key (child_id, academic_year)
);

create index enrolment_class_idx on enrolment (class_group_id, academic_year);

-- ── Guardian ─────────────────────────────────────────────────────────────────
create table guardian (
  id          uuid primary key default app.uuidv7(),
  public_ref  text not null unique default app.public_ref(),
  email       citext not null unique,
  -- Field-level encryption at the application layer (§15.2).
  phone_enc   bytea,
  full_name   text not null,
  locale      text not null default 'af' check (locale in ('af','en')),
  verified_at timestamptz,
  status      text not null default 'active'
                check (status in ('active','suspended','deleted')),
  -- POPIA s69: direct marketing needs its own opt-in, never bundled with the
  -- consent that makes the service work (§3.3).
  marketing_opt_in_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger guardian_touch before update on guardian
  for each row execute function app.touch_updated_at();

create table guardian_session (
  id           uuid primary key default app.uuidv7(),
  guardian_id  uuid not null references guardian(id) on delete cascade,
  token_hash   bytea not null unique,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index guardian_session_guardian_idx on guardian_session (guardian_id)
  where revoked_at is null;

-- ── The binding (§6.2) ───────────────────────────────────────────────────────
-- This single table is what makes "parents may only ever see their own child's
-- photographs" enforceable. Every guardian-facing RLS policy resolves through it.
create table guardian_child (
  studio_id    uuid not null references studio(id) on delete restrict,
  guardian_id  uuid not null references guardian(id) on delete cascade,
  child_id     uuid not null references child(id) on delete cascade,
  relationship text check (relationship in
                 ('parent','guardian','grandparent','other')),
  bound_via    text not null check (bound_via in ('claim_code','admin','invite')),
  bound_at     timestamptz not null default now(),
  bound_ip     inet,
  revoked_at   timestamptz,
  revoked_by   uuid references staff_user(id),
  revoked_reason text,
  primary key (guardian_id, child_id)
);

create index guardian_child_child_idx on guardian_child (child_id)
  where revoked_at is null;
create index guardian_child_guardian_idx on guardian_child (guardian_id)
  where revoked_at is null;

-- ── Claim codes (§6.2) ───────────────────────────────────────────────────────
-- The printed code is a credential, so it is hashed like a password. Only a
-- three-character hint is kept, for the support conversation. If this table
-- leaks, the paper slips are not compromised (§5.4).
create table claim_code (
  id          uuid primary key default app.uuidv7(),
  studio_id   uuid not null references studio(id) on delete restrict,
  child_id    uuid not null references child(id) on delete cascade,
  shoot_id    uuid not null references shoot(id) on delete cascade,

  code_hash   bytea not null,          -- Argon2id, computed in the application
  code_hint   text  not null,          -- last 3 characters only
  -- Increments on regeneration; the previous generation stops working.
  -- This is what the brief's "regenerate QR codes" has to mean (§6.2).
  generation  int   not null default 1 check (generation >= 1),

  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by uuid references guardian(id),
  redeemed_ip inet,
  revoked_at  timestamptz,
  revoked_by  uuid references staff_user(id),

  constraint claim_code_redeemed_has_guardian check (
    (redeemed_at is null) = (redeemed_by is null)
  ),
  constraint claim_code_expiry_after_issue check (expires_at > issued_at)
);

-- One live code per child per shoot per generation.
create unique index claim_code_generation_idx
  on claim_code (child_id, shoot_id, generation);
-- Lookup path for redemption is by hash, not by child.
create unique index claim_code_hash_idx on claim_code (code_hash);
create index claim_code_shoot_idx on claim_code (shoot_id)
  where redeemed_at is null and revoked_at is null;

create or replace function app.claim_code_is_live(c claim_code) returns boolean
language sql stable
as $$
  select c.redeemed_at is null
     and c.revoked_at  is null
     and c.expires_at  > now();
$$;

-- A claim code must never be issued for a child who must not be published.
-- Belt and braces alongside the application check (§2.4).
create or replace function app.enforce_claim_suppression() returns trigger
language plpgsql
as $$
declare
  st text;
begin
  select suppression_status into st from child where id = new.child_id;
  if st <> 'none' then
    raise exception 'Cannot issue a claim code for child % — suppression status is %.',
      new.child_id, st
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger claim_code_suppression_gate
  before insert on claim_code
  for each row execute function app.enforce_claim_suppression();

-- ── Pre-claim sessions (§6.3) ────────────────────────────────────────────────
-- The deliberate, bounded trade of a little security for a lot of conversion:
-- a parent sees the watermarked gallery before any account exists. Short-lived,
-- single child, single shoot, first name only, heavily rate-limited.
create table preview_session (
  id          uuid primary key default app.uuidv7(),
  studio_id   uuid not null references studio(id) on delete restrict,
  child_id    uuid not null references child(id) on delete cascade,
  shoot_id    uuid not null references shoot(id) on delete cascade,
  claim_code_id uuid not null references claim_code(id) on delete cascade,
  token_hash  bytea not null unique,
  ip          inet,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  converted_at timestamptz              -- set when it becomes a real account
);

create index preview_session_expiry_idx on preview_session (expires_at);

-- ── Claim attempt log (§6.2 rate limiting, §15.1 enumeration) ────────────────
-- Deliberately separate from the audit log: high volume, short retention,
-- and queried on a hot path for rate-limiting decisions.
create table claim_attempt (
  id          bigserial primary key,
  attempted_at timestamptz not null default now(),
  ip          inet not null,
  code_hint   text,                     -- never the submitted code itself
  outcome     text not null check (outcome in
                ('success','not_found','expired','revoked','already_redeemed','rate_limited')),
  claim_code_id uuid references claim_code(id) on delete set null
);

create index claim_attempt_ip_idx on claim_attempt (ip, attempted_at desc);
create index claim_attempt_recent_idx on claim_attempt (attempted_at desc);

-- ── Consent (§3.3) ───────────────────────────────────────────────────────────
-- Append-only. A consent whose exact wording you cannot reproduce is a consent
-- you cannot prove, so the shown text version is part of the evidence.
create table consent_record (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  child_id      uuid not null references child(id) on delete cascade,
  guardian_id   uuid not null references guardian(id) on delete cascade,
  shoot_id      uuid references shoot(id) on delete set null,
  -- Two scopes, deliberately separate. Bundling them makes the consent
  -- non-specific and therefore weak under POPIA s1/s11 (§3.3).
  scope         text not null check (scope in ('service','marketing')),
  granted_at    timestamptz not null default now(),
  withdrawn_at  timestamptz,
  -- Evidence: the wording version, locale, IP, user agent, timestamp.
  wording_version text not null,
  locale        text not null,
  evidence      jsonb not null default '{}'::jsonb,

  constraint consent_withdrawn_after_granted check (
    withdrawn_at is null or withdrawn_at >= granted_at
  )
);

create index consent_child_idx on consent_record (child_id, scope, granted_at desc);
create unique index consent_live_service_idx
  on consent_record (child_id, guardian_id, scope, shoot_id)
  where withdrawn_at is null;

create or replace function app.has_service_consent(p_child uuid, p_guardian uuid)
returns boolean language sql stable
as $$
  select exists (
    select 1 from consent_record
    where child_id = p_child and guardian_id = p_guardian
      and scope = 'service' and withdrawn_at is null
  );
$$;

commit;

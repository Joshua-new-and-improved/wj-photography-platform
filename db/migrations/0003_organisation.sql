-- ============================================================================
-- 0003_organisation.sql
-- Schools, shoots, grades, classes.
--
-- Architecture refs: §2.7 (school is a scope, not a tenant), §3.3 (school-level
-- authorisation), §5.3, §11.2 (per-school packages).
-- ============================================================================

begin;

-- ── School (§2.7) ────────────────────────────────────────────────────────────
create table school (
  id             uuid primary key default app.uuidv7(),
  studio_id      uuid not null references studio(id) on delete restrict,
  public_ref     text not null unique default app.public_ref(),
  name           text not null,
  -- Short human label ("LL"). Used on job sheets and packing manifests.
  -- Explicitly NOT part of any access credential — that was the flaw in the
  -- reference workflow's LL25f151 scheme (§3.7).
  code           text not null,
  locale         text not null default 'af' check (locale in ('af','en')),
  -- The school's fundraiser cut, in basis points (§2.14, §11.2).
  commission_bps int not null default 0 check (commission_bps between 0 and 10000),

  -- School-level authorisation for the processing (§3.3). Without a live
  -- agreement there is no documented lawful basis, so shoots are blocked.
  agreement_signed_at  timestamptz,
  agreement_expires_at timestamptz,
  agreement_ref        text,
  agreement_covers_group_photos boolean not null default false,

  contact_name   text,
  contact_email  citext,
  contact_phone  text,
  address        text,
  status         text not null default 'active'
                   check (status in ('prospect','active','dormant','archived')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint school_code_unique_per_studio unique (studio_id, code),
  constraint school_agreement_dates check (
    agreement_expires_at is null
    or agreement_signed_at is null
    or agreement_expires_at > agreement_signed_at
  )
);

create index school_studio_idx on school (studio_id, status);
create index school_name_trgm_idx on school using gin (name gin_trgm_ops);

create trigger school_touch before update on school
  for each row execute function app.touch_updated_at();

create or replace function app.school_agreement_is_live(s school) returns boolean
language sql stable
as $$
  select s.agreement_signed_at is not null
     and (s.agreement_expires_at is null or s.agreement_expires_at > now());
$$;

-- ── Grade ────────────────────────────────────────────────────────────────────
create table grade (
  id         uuid primary key default app.uuidv7(),
  studio_id  uuid not null references studio(id) on delete restrict,
  school_id  uuid not null references school(id) on delete cascade,
  name       text not null,                      -- 'Graad R', 'Grade 1'
  -- Normalised form used for import fuzzy-matching (§7.2). Populated by the
  -- application's normaliser, which knows graad↔grade, gr↔grade, klas↔class.
  name_norm  text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),

  constraint grade_unique_per_school unique (school_id, name_norm)
);

create index grade_norm_trgm_idx on grade using gin (name_norm gin_trgm_ops);

-- ── Class ────────────────────────────────────────────────────────────────────
create table class_group (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  school_id     uuid not null references school(id) on delete cascade,
  grade_id      uuid not null references grade(id) on delete cascade,
  name          text not null,                   -- 'A'
  name_norm     text not null,
  academic_year int  not null check (academic_year between 2000 and 2100),
  teacher_name  text,
  created_at    timestamptz not null default now(),

  constraint class_unique unique (school_id, grade_id, name_norm, academic_year)
);

create index class_group_school_year_idx
  on class_group (studio_id, school_id, academic_year);

-- ── Shoot (§5.3) ─────────────────────────────────────────────────────────────
-- The unit of work. A photographer thinks "the Louis Leipoldt family shoot",
-- not "the gallery table" (§10).
create table shoot (
  id                uuid primary key default app.uuidv7(),
  studio_id         uuid not null references studio(id) on delete restrict,
  school_id         uuid not null references school(id) on delete restrict,
  public_ref        text not null unique default app.public_ref(),
  name              text not null,                -- "Familie Foto's 2025"
  kind              text not null check (kind in
                      ('individual','class','family','event','retake')),
  -- Retakes are first-class, not a naming convention (§5.4).
  parent_shoot_id   uuid references shoot(id) on delete set null,
  academic_year     int not null check (academic_year between 2000 and 2100),
  shoot_date        date not null,

  gallery_opens_at  timestamptz,
  order_deadline_at timestamptz,
  -- Drives the retention job (§3.6). Nightly sweep reads this column.
  archive_at        timestamptz,
  -- How long after the deadline late orders are still accepted.
  grace_hours       int not null default 48 check (grace_hours >= 0),

  -- Whether the slate-card workflow (§7.3) is in use for this shoot.
  slate_matching_enabled boolean not null default true,

  status            text not null default 'draft' check (status in
                      ('draft','importing','review','open','closed','archived')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint shoot_retake_has_parent check (
    kind <> 'retake' or parent_shoot_id is not null
  ),
  constraint shoot_deadline_after_open check (
    gallery_opens_at is null or order_deadline_at is null
    or order_deadline_at > gallery_opens_at
  ),
  constraint shoot_archive_after_deadline check (
    archive_at is null or order_deadline_at is null
    or archive_at > order_deadline_at
  )
);

create index shoot_school_idx on shoot (studio_id, school_id, shoot_date desc);
create index shoot_status_idx on shoot (studio_id, status);
create index shoot_archive_due_idx on shoot (archive_at)
  where status <> 'archived' and archive_at is not null;

create trigger shoot_touch before update on shoot
  for each row execute function app.touch_updated_at();

-- A shoot may not open its gallery without a live school agreement (§3.3).
-- Enforced in the database because "we forgot to check the paperwork" is
-- exactly the failure this control exists to prevent.
create or replace function app.enforce_shoot_agreement() returns trigger
language plpgsql
as $$
declare
  s school;
begin
  if new.status in ('open') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select * into s from school where id = new.school_id;
    if not app.school_agreement_is_live(s) then
      raise exception
        'Cannot open shoot %: school % has no live processing agreement (POPIA s35 lawful basis).',
        new.name, s.name
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger shoot_agreement_gate
  before insert or update on shoot
  for each row execute function app.enforce_shoot_agreement();

commit;

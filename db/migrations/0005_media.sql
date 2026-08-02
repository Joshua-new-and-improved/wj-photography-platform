-- ============================================================================
-- 0005_media.sql
-- Import staging, assets, derived variants, and the asset↔child join.
--
-- Architecture refs: §2.3 (many-to-many), §7 (ingestion), §8 (delivery).
-- ============================================================================

begin;

-- ── Import batches (§7.2 two-phase commit) ───────────────────────────────────
-- Nothing is written to the organisation tables until the photographer
-- confirms the parsed tree. This table is the staging area in between.
create table import_batch (
  id           uuid primary key default app.uuidv7(),
  studio_id    uuid not null references studio(id) on delete restrict,
  shoot_id     uuid not null references shoot(id) on delete cascade,
  started_by   uuid not null references staff_user(id),
  status       text not null default 'uploading' check (status in
                 ('uploading','parsing','awaiting_review','committing',
                  'committed','failed','abandoned')),
  file_count   int not null default 0,
  bytes_total  bigint not null default 0,
  -- The parsed tree with per-node confidence and fuzzy-match suggestions,
  -- exactly as rendered on the review screen (§7.2).
  proposal     jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  committed_at timestamptz
);

create index import_batch_shoot_idx on import_batch (shoot_id, created_at desc);

create trigger import_batch_touch before update on import_batch
  for each row execute function app.touch_updated_at();

-- ── Asset ────────────────────────────────────────────────────────────────────
create table asset (
  id            uuid primary key default app.uuidv7(),
  studio_id     uuid not null references studio(id) on delete restrict,
  shoot_id      uuid not null references shoot(id) on delete cascade,
  import_batch_id uuid references import_batch(id) on delete set null,

  -- Content-addressed dedupe. This one constraint makes re-dragging the same
  -- folder harmless, which removes an entire class of support problem because
  -- the photographer will do exactly that (§5.4).
  sha256        bytea not null,
  -- Random storage key, never derived from child or school name, so a leaked
  -- key reveals nothing about its subject (§6.6).
  storage_key   text not null unique,
  bytes         bigint not null check (bytes > 0),
  width         int not null check (width > 0),
  height        int not null check (height > 0),
  content_type  text not null,

  -- EXIF capture time drives slate segmentation (§7.3). Nullable because some
  -- files arrive without it, which is itself a review-flag condition.
  captured_at   timestamptz,
  frame_seq     int,
  camera_model  text,
  original_name text,
  original_path text,             -- the relative path the browser reported

  -- Set when a slate barcode was decoded in this frame (§7.3).
  slate_code    text,
  is_slate      boolean not null default false,

  status        text not null default 'uploaded' check (status in
                  ('uploaded','processing','ready','quarantined','failed')),
  failure_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint asset_sha_unique_per_studio unique (studio_id, sha256)
);

-- Ordering by capture time within a shoot is the hot path for slate
-- segmentation and for the contact-sheet view.
create index asset_shoot_captured_idx on asset (shoot_id, captured_at, frame_seq);
create index asset_status_idx on asset (studio_id, status)
  where status in ('uploaded','processing','failed');
create index asset_slate_idx on asset (shoot_id, captured_at) where is_slate;

create trigger asset_touch before update on asset
  for each row execute function app.touch_updated_at();

-- ── Variants (§8.1) ──────────────────────────────────────────────────────────
-- There is no unwatermarked variant reachable by any pre-purchase code path.
-- 'print' and 'original' are absent from the guardian authorisation surface
-- entirely — not hidden, absent.
create table asset_variant (
  asset_id    uuid not null references asset(id) on delete cascade,
  studio_id   uuid not null references studio(id) on delete restrict,
  kind        text not null check (kind in ('thumb','preview','proof','print')),
  format      text not null check (format in ('avif','webp','jpeg')),
  storage_key text not null unique,
  width       int not null,
  height      int not null,
  bytes       bigint not null,
  watermarked boolean not null,
  created_at  timestamptz not null default now(),
  primary key (asset_id, kind, format),

  -- Structural guarantee, not a convention: anything a guardian can see before
  -- paying is watermarked (§8.1, §8.4).
  constraint variant_preview_kinds_are_watermarked check (
    kind = 'print' or watermarked
  )
);

create index asset_variant_lookup_idx on asset_variant (asset_id, kind);

-- ── Gallery item: the many-to-many join (§2.3) ───────────────────────────────
-- A class photo belongs to thirty children. A sibling photo belongs to two,
-- often in different grades. The folder tree cannot express this, and
-- retrofitting it means rewriting every permission and pricing rule.
create table gallery_item (
  studio_id   uuid not null references studio(id) on delete restrict,
  asset_id    uuid not null references asset(id) on delete cascade,
  child_id    uuid not null references child(id) on delete cascade,
  role        text not null check (role in
                ('individual','class','sibling','event','staff')),
  sort_order  int not null default 0,
  -- Automated systems should surface their doubt, not hide it. The review UI
  -- sorts by confidence ascending (§5.4).
  assigned_by text not null check (assigned_by in
                ('slate','filename','manual','admin','bulk')),
  confidence  numeric(3,2) check (confidence between 0 and 1),
  assigned_at timestamptz not null default now(),
  primary key (asset_id, child_id)
);

create index gallery_item_child_idx on gallery_item (child_id, role, sort_order);
create index gallery_item_review_idx on gallery_item (studio_id, confidence)
  where confidence < 1.0;

-- A suppressed child must never acquire a gallery item (§2.4).
create or replace function app.enforce_gallery_suppression() returns trigger
language plpgsql
as $$
declare
  st text;
begin
  select suppression_status into st from child where id = new.child_id;
  if st <> 'none' then
    raise exception 'Cannot add gallery item for child % — suppression status is %.',
      new.child_id, st
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger gallery_item_suppression_gate
  before insert or update on gallery_item
  for each row execute function app.enforce_gallery_suppression();

commit;

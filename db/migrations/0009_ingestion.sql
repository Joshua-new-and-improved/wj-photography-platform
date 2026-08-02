-- ============================================================================
-- 0009_ingestion.sql
-- Resumable upload sessions, per-file import staging, and the review queue.
--
-- Architecture refs: §7.1 (upload path), §7.2 (two-phase commit),
-- §7.3 (slate segmentation), §7.4 (processing pipeline).
--
-- NOTE: migration 0008's loop has already run, so every table added here needs
-- RLS enabled and a policy written explicitly. A table with RLS on and no
-- policy is deny-all and fails silently at runtime — see db/README.md.
-- ============================================================================

begin;

-- ── Resumable uploads (§7.1) ─────────────────────────────────────────────────
-- Bytes go straight from the browser to object storage via presigned multipart
-- URLs; the application server only ever sees this row. That is what keeps a
-- 60 GB upload from being an application-tier problem.
create table upload_session (
  id              uuid primary key default app.uuidv7(),
  studio_id       uuid not null references studio(id) on delete restrict,
  import_batch_id uuid not null references import_batch(id) on delete cascade,
  storage_key     text not null unique,
  -- The provider's multipart upload handle. Needed to resume or abort.
  provider_upload_id text,
  bytes_total     bigint not null check (bytes_total > 0),
  bytes_uploaded  bigint not null default 0 check (bytes_uploaded >= 0),
  parts_total     int not null check (parts_total > 0),
  parts_completed int not null default 0 check (parts_completed >= 0),
  -- Computed client-side before upload, verified server-side on completion.
  -- A mismatch means a corrupted transfer, which on a South African uplink
  -- pushing 25 GB is a when, not an if.
  sha256_expected bytea,
  status          text not null default 'in_progress' check (status in
                    ('in_progress','completed','aborted','expired','corrupt')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Abandoned multipart uploads accrue storage charges until aborted.
  expires_at      timestamptz not null default now() + interval '7 days',

  constraint upload_parts_sane check (parts_completed <= parts_total),
  constraint upload_bytes_sane  check (bytes_uploaded <= bytes_total)
);

create index upload_session_batch_idx on upload_session (import_batch_id, status);
create index upload_session_sweep_idx on upload_session (expires_at)
  where status = 'in_progress';

create trigger upload_session_touch before update on upload_session
  for each row execute function app.touch_updated_at();

-- ── Per-file staging (§7.2) ──────────────────────────────────────────────────
-- One row per file the browser reported, holding the inferred placement.
-- Nothing reaches `asset` or the organisation tables until the photographer
-- confirms the proposal.
create table import_file (
  id              uuid primary key default app.uuidv7(),
  studio_id       uuid not null references studio(id) on delete restrict,
  import_batch_id uuid not null references import_batch(id) on delete cascade,

  -- The full path the browser reported, e.g. 'Laerskool Alfa/Graad R/Klas A/IMG_1.jpg'.
  relative_path   text not null,
  file_name       text not null,
  bytes           bigint not null check (bytes >= 0),
  sha256          bytea,

  -- Inference output from src/lib/import/folders.ts. Kept as data so the
  -- review screen can be rebuilt, and so a disputed import can be replayed
  -- months later without re-deriving anything.
  inferred_grade  text,
  inferred_class  text,
  confidence      numeric(3,2) check (confidence between 0 and 1),
  issues          text[] not null default '{}',

  status          text not null default 'pending' check (status in
                    ('pending','uploading','uploaded','processed',
                     'skipped','failed','committed')),
  skip_reason     text,        -- 'ignorable', 'duplicate', 'not_an_image'
  failure_reason  text,

  -- Set on commit. The link from staging to the real asset.
  asset_id        uuid references asset(id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint import_file_path_unique unique (import_batch_id, relative_path)
);

create index import_file_batch_idx on import_file (import_batch_id, status);
-- The review screen sorts least-certain first: automated systems should
-- surface their doubt, not hide it (§5.4).
create index import_file_review_idx on import_file (import_batch_id, confidence)
  where confidence < 1.0;
create index import_file_sha_idx on import_file (studio_id, sha256)
  where sha256 is not null;

-- ── Review queue (§7.3) ──────────────────────────────────────────────────────
-- Segmentation output that a human has to look at. Persisted rather than
-- recomputed, so closing the laptop mid-review is not a setback and so the
-- review history survives for audit.
create table import_review_item (
  id              uuid primary key default app.uuidv7(),
  studio_id       uuid not null references studio(id) on delete restrict,
  import_batch_id uuid not null references import_batch(id) on delete cascade,

  kind            text not null check (kind in (
                    'no_slates_found','frames_before_first_slate','empty_segment',
                    'oversized_segment','unknown_slate_code','duplicate_slate',
                    'suspicious_gap','missing_capture_time','unordered_frames',
                    'unrecognised_folder','bare_number_grade','ambiguous_class',
                    'flat_structure','files_at_root','no_grade_found')),
  slate_code      text,
  asset_ids       uuid[] not null default '{}',
  detail          text not null,

  resolved_at     timestamptz,
  resolved_by     uuid references staff_user(id),
  resolution      text,        -- 'assigned','ignored','reimported','deleted'
  created_at      timestamptz not null default now()
);

create index import_review_open_idx on import_review_item (import_batch_id)
  where resolved_at is null;

-- ── Slate decoding results ───────────────────────────────────────────────────
-- Recorded separately from asset.slate_code so a failed or ambiguous decode is
-- visible. "No code found" and "code found but unreadable" are different
-- problems with different fixes, and collapsing them loses that.
create table slate_decode (
  asset_id     uuid primary key references asset(id) on delete cascade,
  studio_id    uuid not null references studio(id) on delete restrict,
  outcome      text not null check (outcome in
                 ('decoded','no_barcode_found','unreadable','multiple_found')),
  code         text,
  symbology    text,        -- 'CODE_128', 'QR_CODE'
  decoded_at   timestamptz not null default now(),

  constraint slate_decode_has_code check ((outcome = 'decoded') = (code is not null))
);

create index slate_decode_shoot_idx on slate_decode (studio_id, outcome);

-- ── RLS for the new tables ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'upload_session','import_file','import_review_item','slate_decode'
  ] loop
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

-- Ingestion is a photographer's job, not an assistant's. Assistants tag; they
-- do not import (§6.5). Guardians have no visibility here at all — there is
-- deliberately no guardian policy on any of these tables.
create policy import_min_photographer on upload_session as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));

create policy import_file_min_assistant on import_file as restrictive
  for all using (not app.is_staff() or app.staff_at_least('assistant'));

create policy review_min_assistant on import_review_item as restrictive
  for all using (not app.is_staff() or app.staff_at_least('assistant'));

commit;

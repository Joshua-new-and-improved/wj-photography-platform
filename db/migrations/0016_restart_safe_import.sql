-- 0016 — Uploads survive a restart.
--
-- The importer kept each uploaded file's storage keys, and the child it was
-- matched to, in two in-memory maps. A server restart between "upload" and
-- "publish" (a deploy, a crash, a memory spike) silently lost them: the files
-- stayed on disk but nothing pointed at them, the photos never reached a
-- gallery, and the disk filled with orphans. This happened in production on
-- 2026-11-24. The same facts now live on the import_file row itself.
--
-- Re-runnable: the server applies migrations on boot.

begin;

alter table import_file
  add column if not exists original_key text,
  add column if not exists thumb_key    text,
  add column if not exists preview_key  text,
  add column if not exists width        int,
  add column if not exists height       int,
  add column if not exists child_id     uuid references child(id) on delete set null;

comment on column import_file.original_key is
  'Storage key of the uploaded original while staged. Together with the variant keys this lets publish run after a restart, and lets the storage sweep tell a staged file from an orphan.';

create index if not exists import_file_staged_idx on import_file (created_at)
  where status in ('uploaded','processed');

commit;

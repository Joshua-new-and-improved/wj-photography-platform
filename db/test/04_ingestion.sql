-- ============================================================================
-- 04_ingestion.sql
-- Assertions for the ingestion staging tables (migration 0009).
-- ============================================================================

\pset tuples_only on
\pset format unaligned

\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set studio_b  '''bbbbbbbb-0000-4000-8000-000000000001'''
\set staff_owner  '''aaaaaaaa-0000-4000-8000-000000000010'''
\set staff_photog '''aaaaaaaa-0000-4000-8000-000000000011'''
\set staff_asst   '''aaaaaaaa-0000-4000-8000-000000000012'''
\set staff_b      '''bbbbbbbb-0000-4000-8000-000000000010'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''
\set guard_1   '''aaaaaaaa-0000-4000-8000-000000000060'''
\set batch     '''aaaaaaaa-0000-4000-8000-0000000000c0'''

set role app_rw;
select test.as_staff(:studio_a, :staff_photog, 'photographer');

insert into import_batch (id, studio_id, shoot_id, started_by, status, file_count)
  values (:batch, :studio_a, :shoot_a, :staff_photog, 'awaiting_review', 3);

insert into import_file (studio_id, import_batch_id, relative_path, file_name,
                         bytes, inferred_grade, inferred_class, confidence, issues)
values
  (:studio_a, :batch, 'Laerskool Alfa/Graad R/Klas A/IMG_001.jpg', 'IMG_001.jpg',
   1200000, 'Grade R', 'A', 1.00, '{}'),
  (:studio_a, :batch, 'Laerskool Alfa/Graad R - B/IMG_002.jpg', 'IMG_002.jpg',
   1200000, 'Grade R', 'B', 0.90, '{flat_structure}'),
  (:studio_a, :batch, 'Laerskool Alfa/_RETAKES/IMG_500.jpg', 'IMG_500.jpg',
   1200000, null, null, null, '{unrecognised_folder}');

\echo ''
\echo '── Group 15: import staging (§7.2) ────────────────────────────────────'
select test.rowcount('select 1 from import_file', 3, 'photographer sees the staged files');
select test.rowcount(
  'select 1 from import_file where confidence is null or confidence < 1.0',
  2, 'two files need review, one parsed cleanly');

-- Re-dragging the same folder must not create a second staging row.
select test.throws(
  'insert into import_file (studio_id, import_batch_id, relative_path, file_name, bytes)'
  || ' values (' || quote_literal(:studio_a) || ',' || quote_literal(:batch)
  || ', ''Laerskool Alfa/Graad R/Klas A/IMG_001.jpg'', ''IMG_001.jpg'', 1)',
  'the same relative path cannot be staged twice in one batch');

\echo ''
\echo '── Group 16: upload sessions (§7.1) ───────────────────────────────────'
insert into upload_session (studio_id, import_batch_id, storage_key,
                            bytes_total, parts_total, parts_completed, bytes_uploaded)
  values (:studio_a, :batch, 'staging/abc123', 60000000, 8, 3, 24000000);
select test.ok(true, 'a resumable upload session can be recorded');

select test.throws(
  'update upload_session set parts_completed = 99 where storage_key = ''staging/abc123''',
  'an upload cannot report more completed parts than it has');

select test.throws(
  'update upload_session set bytes_uploaded = 999999999 where storage_key = ''staging/abc123''',
  'an upload cannot report more bytes than the file contains');

\echo ''
\echo '── Group 17: slate decoding (§7.3) ────────────────────────────────────'
insert into slate_decode (asset_id, studio_id, outcome, code, symbology)
  values ('aaaaaaaa-0000-4000-8000-000000000070', :studio_a, 'decoded', 'LL001', 'CODE_128');
insert into slate_decode (asset_id, studio_id, outcome)
  values ('aaaaaaaa-0000-4000-8000-000000000071', :studio_a, 'no_barcode_found');
select test.rowcount('select 1 from slate_decode', 2, 'decode outcomes are recorded per frame');

-- "No code found" and "code found but unreadable" are different problems.
-- Recording a code against a failed decode would collapse that distinction.
select test.throws(
  'insert into slate_decode (asset_id, studio_id, outcome, code) values ('
  || '''aaaaaaaa-0000-4000-8000-000000000072'',' || quote_literal(:studio_a)
  || ', ''unreadable'', ''LL999'')',
  'a failed decode cannot carry a code');

\echo ''
\echo '── Group 18: ingestion access control (§6.5) ──────────────────────────'
select test.as_staff(:studio_a, :staff_asst, 'assistant');
select test.rowcount('select 1 from import_file', 3,
                     'assistant CAN see staged files (tagging is their job)');
select test.rowcount('select 1 from upload_session', 0,
                     'assistant CANNOT see upload sessions — importing is not their job');

select test.as_staff(:studio_b, :staff_b, 'owner');
select test.rowcount('select 1 from import_file', 0,
                     'another studio sees none of this import');
select test.rowcount('select 1 from slate_decode', 0,
                     'another studio sees none of these slate decodes');

select test.as_guardian(:guard_1);
select test.rowcount('select 1 from import_file', 0, 'guardian sees no import staging');
select test.rowcount('select 1 from slate_decode', 0, 'guardian sees no slate decodes');
select test.rowcount('select 1 from import_review_item', 0, 'guardian sees no review queue');

reset role;

-- ============================================================================
-- 05_event_mode.sql — browse mode vs gated mode (migration 0010).
-- ============================================================================
\pset tuples_only on
\pset format unaligned

\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set staff_owner '''aaaaaaaa-0000-4000-8000-000000000010'''
\set staff_asst  '''aaaaaaaa-0000-4000-8000-000000000012'''
\set school_a  '''aaaaaaaa-0000-4000-8000-000000000020'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''
\set child_1   '''aaaaaaaa-0000-4000-8000-000000000050'''
\set guard_1   '''aaaaaaaa-0000-4000-8000-000000000060'''
\set asset_p1  '''aaaaaaaa-0000-4000-8000-000000000070'''
\set ev        '''aaaaaaaa-0000-4000-8000-0000000000e0'''
\set evasset   '''aaaaaaaa-0000-4000-8000-0000000000e1'''

set role app_rw;
select test.as_staff(:studio_a, :staff_owner, 'owner');

insert into shoot (id, studio_id, school_id, name, kind, academic_year, shoot_date,
                   status, access_mode, classification, discipline, gallery_opens_at)
  values (:ev, :studio_a, :school_a, 'Acro Sport Nationals 2026', 'event', 2026,
          current_date, 'open', 'browse', 'sports', 'Dance',
          now() - interval '1 hour');

insert into asset (id, studio_id, shoot_id, sha256, storage_key, bytes, width, height,
                   content_type, status)
  values (:evasset, :studio_a, :ev, digest('ev1','sha256'), 'k/ev1', 900000,
          6000, 4000, 'image/jpeg', 'ready');
insert into asset_variant (asset_id, studio_id, kind, format, storage_key,
                           width, height, bytes, watermarked)
  values (:evasset, :studio_a, 'preview', 'webp', 'k/ev1.prev', 1200, 800, 90000, true),
         (:evasset, :studio_a, 'print', 'jpeg', 'k/ev1.print', 6000, 4000, 8000000, false);

\echo ''
\echo '── Group 19: reference numbers (§ migration 0010) ─────────────────────'
select test.rowcount('select 1 from asset where id = ' || quote_literal(:evasset)
                     || ' and reference_no = 1', 1,
                     'the first frame in an event gets reference 1');

insert into asset (studio_id, shoot_id, sha256, storage_key, bytes, width, height,
                   content_type, status)
  values (:studio_a, :ev, digest('ev2','sha256'), 'k/ev2', 900000, 6000, 4000,
          'image/jpeg', 'ready');
select test.rowcount('select 1 from asset where shoot_id = ' || quote_literal(:ev)
                     || ' and reference_no = 2', 1, 'references increment per shoot');

\echo ''
\echo '── Group 20: the public path is bolted shut by default (0011) ─────────'
-- v1 is crèche and primary portrait day only. Browse mode exists but must be
-- unreachable until somebody deliberately enables it.
select test.as_nobody();
select test.rowcount('select 1 from shoot', 0,
                     'with event mode OFF, anonymous visitor sees NOTHING');
select test.rowcount('select 1 from asset', 0,
                     'with event mode OFF, no asset is publicly readable');

-- Now flip the master switch and prove the door opens — and, more importantly,
-- that it closes again.
reset role;
update studio set event_mode_enabled = true where id = :studio_a;
set role app_rw;
select test.as_nobody();
select test.rowcount('select 1 from shoot', 1, 'with event mode ON, the event becomes visible');
select test.rowcount('select 1 from shoot where access_mode = ''gated''', 0,
                     'anonymous visitor sees NO gated shoot');
select test.rowcount('select 1 from asset', 2, 'anonymous visitor sees both event frames');
select test.rowcount('select 1 from asset where id = ' || quote_literal(:asset_p1), 0,
                     'anonymous visitor CANNOT see a portrait-day frame');
select test.rowcount('select 1 from asset_variant', 1, 'anonymous visitor sees one variant');
select test.rowcount('select 1 from asset_variant where kind = ''print''', 0,
                     'anonymous visitor CANNOT see the print variant');
select test.rowcount('select 1 from asset_variant where not watermarked', 0,
                     'anonymous visitor CANNOT see anything unwatermarked');
select test.rowcount('select 1 from child', 0, 'browse mode exposes no child records at all');

reset role;
update studio set event_mode_enabled = false where id = :studio_a;
set role app_rw;
select test.as_nobody();
select test.rowcount('select 1 from asset', 0,
                     'turning event mode OFF again actually closes the door');

\echo ''
\echo '── Group 21: a browse shoot can never name a child ────────────────────'
select test.as_staff(:studio_a, :staff_owner, 'owner');
select test.throws(
  'insert into gallery_item (studio_id, asset_id, child_id, role, assigned_by) values ('
  || quote_literal(:studio_a) || ',' || quote_literal(:evasset) || ','
  || quote_literal(:child_1) || ', ''event'', ''manual'')',
  'an asset in a browse-mode shoot cannot be linked to a named child');

\echo ''
\echo '── Group 22: in-house print production (0011) ─────────────────────────'
select test.as_staff(:studio_a, :staff_owner, 'photographer');

-- An unpaid order. Paper and ink must not be consumed for it.
insert into "order" (id, studio_id, school_id, shoot_id, guardian_id, order_number,
                     subtotal_cents, total_cents, payment_status)
  values ('aaaaaaaa-0000-4000-8000-0000000000f0', :studio_a, :school_a, :shoot_a,
          :guard_1, 'WJ-UNPAID-01', 14500, 14500, 'pending');
insert into order_line (id, studio_id, order_id, child_id, line_no, kind, quantity,
                        unit_cents, line_total_cents, vat_rate_bps, snapshot)
  values ('aaaaaaaa-0000-4000-8000-0000000000f1', :studio_a,
          'aaaaaaaa-0000-4000-8000-0000000000f0', :child_1, 1, 'product', 1,
          14500, 14500, 1500, '{"size":"A4"}');

insert into print_batch (id, studio_id, shoot_id, label, created_by)
  values ('aaaaaaaa-0000-4000-8000-0000000000f2', :studio_a, :shoot_a,
          'Louis Leipoldt — Graad R–3', :staff_owner);
select test.ok(true, 'a print batch can be opened for a shoot');

select test.throws(
  'insert into print_job (studio_id, print_batch_id, order_id, order_line_id, child_id,'
  || ' asset_id, size_label, quantity, crop) values ('
  || quote_literal(:studio_a) || ', ''aaaaaaaa-0000-4000-8000-0000000000f2'','
  || ' ''aaaaaaaa-0000-4000-8000-0000000000f0'', ''aaaaaaaa-0000-4000-8000-0000000000f1'','
  || quote_literal(:child_1) || ',' || quote_literal(:asset_p1)
  || ', ''A4'', 1, ''{"x":0,"y":0.02,"w":1,"h":0.94}'')',
  'an unpaid order cannot consume paper and ink');

update "order" set payment_status = 'settled'
  where id = 'aaaaaaaa-0000-4000-8000-0000000000f0';
insert into print_job (id, studio_id, print_batch_id, order_id, order_line_id, child_id,
                       asset_id, size_label, quantity, crop)
  values ('aaaaaaaa-0000-4000-8000-0000000000f3', :studio_a,
          'aaaaaaaa-0000-4000-8000-0000000000f2', 'aaaaaaaa-0000-4000-8000-0000000000f0',
          'aaaaaaaa-0000-4000-8000-0000000000f1', :child_1, :asset_p1, 'A4', 1,
          '{"x":0,"y":0.019,"w":1,"h":0.943}');
select test.ok(true, 'a settled order CAN be queued for printing');

-- A bad print becomes one reprint job. It must not reset the rest of the order.
select test.throws(
  'insert into print_job (studio_id, order_id, order_line_id, child_id, asset_id,'
  || ' size_label, quantity, crop, reprint_of) values ('
  || quote_literal(:studio_a) || ', ''aaaaaaaa-0000-4000-8000-0000000000f0'','
  || ' ''aaaaaaaa-0000-4000-8000-0000000000f1'',' || quote_literal(:child_1) || ','
  || quote_literal(:asset_p1) || ', ''A4'', 1, ''{}'','
  || ' ''aaaaaaaa-0000-4000-8000-0000000000f3'')',
  'a reprint must record why it was reprinted');

insert into print_job (studio_id, order_id, order_line_id, child_id, asset_id,
                       size_label, quantity, crop, reprint_of, reprint_reason)
  values (:studio_a, 'aaaaaaaa-0000-4000-8000-0000000000f0',
          'aaaaaaaa-0000-4000-8000-0000000000f1', :child_1, :asset_p1, 'A4', 1,
          '{"x":0,"y":0.019,"w":1,"h":0.943}',
          'aaaaaaaa-0000-4000-8000-0000000000f3', 'Colour cast on first pass');
select test.ok(true, 'a reprint with a recorded reason is accepted');

\echo ''
\echo '── Group 23: delivery back to the school ──────────────────────────────'
insert into delivery (id, studio_id, shoot_id, school_id, scheduled_for, order_count)
  values ('aaaaaaaa-0000-4000-8000-0000000000f4', :studio_a, :shoot_a, :school_a,
          current_date + 3, 1);
update "order" set delivery_id = 'aaaaaaaa-0000-4000-8000-0000000000f4'
  where id = 'aaaaaaaa-0000-4000-8000-0000000000f0';
select test.rowcount(
  'select 1 from "order" where delivery_id = ''aaaaaaaa-0000-4000-8000-0000000000f4''',
  1, 'orders are grouped into one delivery to the school');

select test.as_staff(:studio_a, :staff_asst, 'assistant');
select test.rowcount('select 1 from print_batch', 0,
                     'assistant CANNOT see the production queue');
select test.rowcount('select 1 from delivery', 0,
                     'assistant CANNOT see deliveries');

reset role;

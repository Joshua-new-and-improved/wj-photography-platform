-- ============================================================================
-- 03_invariants.sql
-- Business rules that the database enforces regardless of what the application
-- does. Each of these exists because "the code will remember to check" is not
-- a control.
-- ============================================================================

\pset tuples_only on
\pset format unaligned

\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set staff_owner  '''aaaaaaaa-0000-4000-8000-000000000010'''
\set school_a  '''aaaaaaaa-0000-4000-8000-000000000020'''
\set school_no_agreement '''aaaaaaaa-0000-4000-8000-000000000021'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''
\set child_1   '''aaaaaaaa-0000-4000-8000-000000000050'''
\set guard_1   '''aaaaaaaa-0000-4000-8000-000000000060'''
\set asset_p1  '''aaaaaaaa-0000-4000-8000-000000000070'''

set role app_rw;
select test.as_staff(:studio_a, :staff_owner, 'owner');

\echo ''
\echo '── Group 8: lawful basis gate (§3.3) ──────────────────────────────────'
-- A shoot may not open its gallery at a school with no live agreement.
select test.throws(
  'insert into shoot (studio_id, school_id, name, kind, academic_year, shoot_date, status)'
  || ' values (' || quote_literal(:studio_a) || ',' || quote_literal(:school_no_agreement)
  || ', ''Unlawful Shoot'', ''individual'', 2026, current_date, ''open'')',
  'cannot open a shoot at a school with no signed processing agreement');

-- The same shoot in draft is fine — the gate is on opening, not on planning.
insert into shoot (studio_id, school_id, name, kind, academic_year, shoot_date, status)
  values (:studio_a, :school_no_agreement, 'Planned Shoot', 'individual', 2026,
          current_date, 'draft');
select test.ok(true, 'a draft shoot at the same school is allowed');

\echo ''
\echo '── Group 9: payment / fulfilment separation (§12.1) ────────────────────'
insert into "order" (id, studio_id, school_id, shoot_id, guardian_id, order_number,
                     subtotal_cents, vat_cents, total_cents, payment_status)
  values ('aaaaaaaa-0000-4000-8000-0000000000b0', :studio_a, :school_a, :shoot_a,
          :guard_1, 'ORD-TEST-0001', 8500, 1109, 8500, 'pending');

select test.throws(
  'update "order" set fulfilment_status = ''in_production'''
  || ' where order_number = ''ORD-TEST-0001''',
  'unpaid order cannot enter production');

update "order" set payment_status = 'settled' where order_number = 'ORD-TEST-0001';
update "order" set fulfilment_status = 'in_production' where order_number = 'ORD-TEST-0001';
select test.ok(true, 'settled order CAN enter production');

-- The cash-at-the-school-office case (§2.11): unpaid online, but an offline
-- payment is recorded, so fulfilment proceeds.
insert into "order" (id, studio_id, school_id, shoot_id, guardian_id, order_number,
                     subtotal_cents, total_cents, payment_status,
                     offline_method, offline_ref, placed_by_staff_id)
  values ('aaaaaaaa-0000-4000-8000-0000000000b1', :studio_a, :school_a, :shoot_a,
          :guard_1, 'ORD-TEST-0002', 8500, 8500, 'pending',
          'cash', 'Receipt 00412', :staff_owner);
update "order" set fulfilment_status = 'queued' where order_number = 'ORD-TEST-0002';
select test.ok(true, 'offline cash order CAN enter fulfilment (§2.11)');

select test.throws(
  'insert into "order" (studio_id, school_id, shoot_id, guardian_id, order_number,'
  || ' subtotal_cents, total_cents, offline_method) values ('
  || quote_literal(:studio_a) || ',' || quote_literal(:school_a) || ','
  || quote_literal(:shoot_a) || ',' || quote_literal(:guard_1)
  || ', ''ORD-TEST-0003'', 100, 100, ''cash'')',
  'an offline payment method without a reference is rejected');

select test.throws(
  'insert into "order" (studio_id, school_id, shoot_id, guardian_id, order_number,'
  || ' subtotal_cents, delivery_cents, total_cents) values ('
  || quote_literal(:studio_a) || ',' || quote_literal(:school_a) || ','
  || quote_literal(:shoot_a) || ',' || quote_literal(:guard_1)
  || ', ''ORD-TEST-0004'', 8500, 5000, 8500)',
  'order totals that do not add up are rejected');

\echo ''
\echo '── Group 10: media invariants (§5.4, §8.1) ────────────────────────────'
-- Re-dragging the same folder must be harmless.
select test.throws(
  'insert into asset (studio_id, shoot_id, sha256, storage_key, bytes, width, height,'
  || ' content_type) values (' || quote_literal(:studio_a) || ',' || quote_literal(:shoot_a)
  || ', digest(''p1'',''sha256''), ''k/p1-again'', 1, 1, 1, ''image/jpeg'')',
  'duplicate content hash is rejected (re-dragging a folder is a no-op)');

select test.throws(
  'insert into asset_variant (asset_id, studio_id, kind, format, storage_key,'
  || ' width, height, bytes, watermarked) values (' || quote_literal(:asset_p1) || ','
  || quote_literal(:studio_a) || ', ''proof'', ''webp'', ''k/leak'', 1, 1, 1, false)',
  'an unwatermarked preview-class variant cannot be created');

\echo ''
\echo '── Group 11: staff invariants (§6.5) ──────────────────────────────────'
select test.throws(
  'insert into staff_user (studio_id, email, full_name, role, status, mfa_enabled)'
  || ' values (' || quote_literal(:studio_a)
  || ', ''admin2@a.test'', ''No MFA Admin'', ''admin'', ''active'', false)',
  'an active admin without MFA is rejected');

select test.throws(
  'insert into staff_user (studio_id, email, full_name, role, status, mfa_enabled)'
  || ' values (' || quote_literal(:studio_a)
  || ', ''owner2@a.test'', ''Second Owner'', ''owner'', ''active'', true)',
  'a second owner for the same studio is rejected');

reset role;

\echo ''
\echo '── Group 12: audit chain is tamper-evident (§15.3) ─────────────────────'
-- Runs as the owner, because the point is to prove that even a privileged
-- connection cannot rewrite history undetectably.
insert into audit_event (studio_id, actor_kind, actor_label, action, subject_type, subject_id)
values (:studio_a, 'guardian', 'Guardian One', 'gallery.viewed', 'child', :child_1),
       (:studio_a, 'staff', 'A Owner', 'price.changed', 'price', null),
       (:studio_a, 'guardian', 'Guardian One', 'asset.downloaded', 'asset', :asset_p1);

select test.ok((select ok from app.audit_verify(:studio_a)), 'audit chain verifies clean');
select test.ok((select checked from app.audit_verify(:studio_a)) = 3,
               'audit chain contains the 3 expected events');

select test.throws(
  'update audit_event set action = ''nothing.happened'' where seq = 2',
  'audit_event rejects UPDATE');
select test.throws(
  'delete from audit_event where seq = 2',
  'audit_event rejects DELETE');

-- Now simulate an attacker with enough privilege to disable the triggers.
-- The hash chain must still catch the edit.
alter table audit_event disable trigger audit_event_no_update;
update audit_event set action = 'nothing.happened'
  where studio_id = :studio_a and seq = 2;
alter table audit_event enable trigger audit_event_no_update;

select test.ok(not (select ok from app.audit_verify(:studio_a)),
               'a row edited with triggers disabled is DETECTED by the hash chain');
select test.eq((select first_bad_seq from app.audit_verify(:studio_a)), 2::bigint,
               'the chain names the exact tampered event');

-- Restore, so later suites start from a clean chain.
alter table audit_event disable trigger audit_event_no_update;
update audit_event set action = 'price.changed'
  where studio_id = :studio_a and seq = 2;
alter table audit_event enable trigger audit_event_no_update;
select test.ok((select ok from app.audit_verify(:studio_a)),
               'chain verifies again once the row is restored');

\echo ''
\echo '── Group 13: identifier helpers (§5.2) ────────────────────────────────'
select test.eq(length(app.public_ref()), 22, 'public_ref is 22 characters');
select test.eq(count(distinct app.public_ref())::int, 500,
               'public_ref: 500 draws, no collisions')
  from generate_series(1, 500);
select test.eq(substring(app.uuidv7()::text, 15, 1), '7', 'uuidv7 sets version nibble 7');
select test.ok(substring(app.uuidv7()::text, 20, 1) in ('8','9','a','b'),
               'uuidv7 sets the RFC 4122 variant bits');

-- Sortability has to be measured across milliseconds; within one millisecond
-- the random tail dominates by design.
select test.ok(
  (select a < b from (select app.uuidv7() a, pg_sleep(0.01), app.uuidv7() b) t),
  'uuidv7 is time-sortable across milliseconds');

\echo ''
\echo '── Group 14: search behaves for SA names (§13) ────────────────────────'
-- The interface is English, but the names in it are not. Afrikaans, isiZulu and
-- Sesotho surnames carry diacritics and the parents typing them will not.
set role app_rw;
select test.as_staff(:studio_a, :staff_owner, 'owner');
select test.rowcount(
  'select 1 from child where app.immutable_unaccent(first_name) ilike ''Zane%''',
  1, 'unaccented search finds "Zané" when the user types "Zane"');
select test.rowcount(
  'select 1 from child where search_vector @@ plainto_tsquery(''simple'', ''botha'')',
  2, 'full-text search finds both Botha children');
reset role;

\echo ''
\echo '── Group 14b: English-only catalogue (0012) ──────────────────────────'
set role app_rw;
select test.as_staff(:studio_a, :staff_owner, 'owner');

-- A normal English-only product must save. Before 0012 the constraint demanded
-- an Afrikaans key too and would have rejected this outright.
insert into product (studio_id, sku, name_i18n, kind, active)
  values (:studio_a, 'MUG-STD', '{"en":"Photo mug"}', 'merch', true);
select test.ok(true, 'an English-only product is accepted');

select test.throws(
  'insert into product (studio_id, sku, name_i18n, kind) values ('
  || quote_literal(:studio_a) || ', ''NO-EN'', ''{"af":"Beker"}'', ''merch'')',
  'a product with no English name is rejected');

select test.rowcount(
  'select 1 from studio where default_locale <> ''en''', 0,
  'every studio defaults to English');
reset role;

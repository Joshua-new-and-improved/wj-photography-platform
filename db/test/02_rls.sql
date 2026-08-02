-- ============================================================================
-- 02_rls.sql
-- The security assertions. Every claim made in §6 and §15 of the architecture
-- that can be expressed as a query is expressed as a query here.
--
-- Runs entirely as app_rw — the role the application actually uses, which is
-- neither the table owner nor BYPASSRLS. Asserting under any other role would
-- be asserting nothing.
-- ============================================================================

set role app_rw;

\pset tuples_only on
\pset format unaligned

\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set studio_b  '''bbbbbbbb-0000-4000-8000-000000000001'''
\set staff_owner  '''aaaaaaaa-0000-4000-8000-000000000010'''
\set staff_photog '''aaaaaaaa-0000-4000-8000-000000000011'''
\set staff_asst   '''aaaaaaaa-0000-4000-8000-000000000012'''
\set staff_b      '''bbbbbbbb-0000-4000-8000-000000000010'''
\set school_a  '''aaaaaaaa-0000-4000-8000-000000000020'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''
\set child_1   '''aaaaaaaa-0000-4000-8000-000000000050'''
\set child_2   '''aaaaaaaa-0000-4000-8000-000000000051'''
\set child_sup '''aaaaaaaa-0000-4000-8000-000000000052'''
\set guard_1   '''aaaaaaaa-0000-4000-8000-000000000060'''
\set guard_2   '''aaaaaaaa-0000-4000-8000-000000000061'''
\set asset_p1  '''aaaaaaaa-0000-4000-8000-000000000070'''
\set asset_p2  '''aaaaaaaa-0000-4000-8000-000000000071'''
\set asset_cls '''aaaaaaaa-0000-4000-8000-000000000072'''

\echo ''
\echo '── Group 1: unauthenticated context sees nothing ──────────────────────'
select test.as_nobody();
select test.rowcount('select 1 from child',        0, 'no context: child invisible');
select test.rowcount('select 1 from asset',        0, 'no context: asset invisible');
select test.rowcount('select 1 from asset_variant',0, 'no context: variants invisible');
select test.rowcount('select 1 from "order"',      0, 'no context: orders invisible');
select test.rowcount('select 1 from guardian',     0, 'no context: guardians invisible');

\echo ''
\echo '── Group 2: cross-tenant isolation (§5.1) ─────────────────────────────'
select test.as_staff(:studio_a, :staff_owner, 'owner');
select test.rowcount('select 1 from child', 3, 'studio A owner sees exactly its own 3 children');
select test.rowcount('select 1 from child where school_id in (select id from school)', 3,
                     'studio A owner: children all resolve to visible schools');

select test.as_staff(:studio_b, :staff_b, 'owner');
select test.rowcount('select 1 from child', 1, 'studio B owner sees only its own child');
select test.rowcount('select 1 from asset', 0, 'studio B owner sees none of studio A''s assets');
select test.rowcount('select 1 from shoot', 0, 'studio B owner sees none of studio A''s shoots');

-- The dangerous case: a staff member who knows the other tenant's UUID.
select test.rowcount(
  'select 1 from child where id = ' || quote_literal(:child_1),
  0, 'studio B owner cannot read a studio A child by direct id');

-- And cannot write into the other tenant either.
select test.throws(
  'insert into child (studio_id, school_id, first_name, last_name) values ('
  || quote_literal(:studio_a) || ',' || quote_literal(:school_a) || ', ''Injected'', ''Row'')',
  'studio B owner cannot insert a row scoped to studio A');

\echo ''
\echo '── Group 3: guardian isolation (§6.2) — the core promise ──────────────'
select test.as_guardian(:guard_1);
select test.rowcount('select 1 from child', 1, 'guardian 1 sees exactly one child');
select test.rowcount('select 1 from child where id = ' || quote_literal(:child_1), 1,
                     'guardian 1 sees their own child');
select test.rowcount('select 1 from child where id = ' || quote_literal(:child_2), 0,
                     'guardian 1 CANNOT see another parent''s child');
select test.rowcount('select 1 from child where id = ' || quote_literal(:child_sup), 0,
                     'guardian 1 cannot see the suppressed child');

-- Assets: own portrait plus the shared class photo, and nothing else.
select test.rowcount('select 1 from asset', 2,
                     'guardian 1 sees 2 assets: own portrait + class photo');
select test.rowcount('select 1 from asset where id = ' || quote_literal(:asset_p2), 0,
                     'guardian 1 CANNOT see the other child''s portrait');
select test.rowcount('select 1 from asset where id = ' || quote_literal(:asset_cls), 1,
                     'guardian 1 CAN see the shared class photo');

select test.as_guardian(:guard_2);
select test.rowcount('select 1 from asset where id = ' || quote_literal(:asset_cls), 1,
                     'guardian 2 also sees the same class photo (§2.3 many-to-many)');
select test.rowcount('select 1 from asset where id = ' || quote_literal(:asset_p1), 0,
                     'guardian 2 CANNOT see guardian 1''s portrait');

\echo ''
\echo '── Group 4: no unwatermarked bytes before payment (§8.1) ──────────────'
select test.as_guardian(:guard_1);
select test.rowcount('select 1 from asset_variant', 3,
                     'guardian sees 3 variants (2 for own portrait, 1 class thumb)');
select test.rowcount('select 1 from asset_variant where kind = ''print''', 0,
                     'guardian CANNOT see any print variant');
select test.rowcount('select 1 from asset_variant where not watermarked', 0,
                     'guardian CANNOT see any unwatermarked variant');
select test.rowcount('select 1 from download_grant', 0,
                     'guardian has no download grants without a paid order');

\echo ''
\echo '── Group 5: suppression register (§2.4) ───────────────────────────────'
select test.as_staff(:studio_a, :staff_owner, 'owner');
select test.throws(
  'insert into gallery_item (studio_id, asset_id, child_id, role, assigned_by) values ('
  || quote_literal(:studio_a) || ',' || quote_literal(:asset_p1) || ',' || quote_literal(:child_sup) || ', ''individual'', ''manual'')',
  'cannot add a gallery item for a suppressed child');
select test.throws(
  'insert into claim_code (studio_id, child_id, shoot_id, code_hash, code_hint, expires_at) values ('
  || quote_literal(:studio_a) || ',' || quote_literal(:child_sup) || ',' || quote_literal(:shoot_a)
  || ', digest(''x'',''sha256''), ''XYZ'', now() + interval ''7 days'')',
  'cannot issue a claim code for a suppressed child');

\echo ''
\echo '── Group 6: staff role separation (§6.5) ──────────────────────────────'
select test.as_staff(:studio_a, :staff_asst, 'assistant');
select test.rowcount('select 1 from child', 3, 'assistant CAN see children (tagging is their job)');
select test.rowcount('select 1 from "order"', 0, 'assistant CANNOT see orders');
select test.rowcount('select 1 from guardian', 0, 'assistant CANNOT see guardian contact details');

select test.as_staff(:studio_a, :staff_photog, 'photographer');
select test.rowcount('select 1 from guardian', 2, 'photographer CAN see guardians');
select test.throws(
  'insert into price (studio_id, price_list_id, product_id, amount_cents) values ('
  || quote_literal(:studio_a) || ', ''aaaaaaaa-0000-4000-8000-0000000000a0'','
  || ' ''aaaaaaaa-0000-4000-8000-000000000090'', 1)',
  'photographer CANNOT create a price');

select test.as_staff(:studio_a, :staff_owner, 'owner');
insert into price (studio_id, price_list_id, product_id, amount_cents)
  values (:studio_a, 'aaaaaaaa-0000-4000-8000-0000000000a0',
          'aaaaaaaa-0000-4000-8000-000000000090', 9500);
select test.ok(true, 'owner CAN create a price');

\echo ''
\echo '── Group 7: catalogue visibility ──────────────────────────────────────'
select test.as_guardian(:guard_1);
select test.rowcount('select 1 from product where active', 1, 'guardian sees active products');
select test.rowcount('select 1 from price', 2, 'guardian sees prices on the published list');
select test.rowcount('select 1 from shoot', 1, 'guardian sees only the shoot containing their child');
select test.rowcount('select 1 from school', 1, 'guardian sees only their child''s school');

\echo ''
\echo '── Group 7b: the studio row itself ────────────────────────────────────'
select test.as_staff(:studio_a, :staff_owner, 'owner');
select test.rowcount('select 1 from studio', 1, 'staff can read exactly their own studio row');
select test.rowcount('select 1 from studio where id = ' || quote_literal(:studio_b), 0,
                     'staff CANNOT read another studio''s row');
select test.as_guardian(:guard_1);
select test.rowcount('select 1 from studio', 0, 'guardian cannot read any studio row');

reset role;
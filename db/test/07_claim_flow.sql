-- ============================================================================
-- 07_claim_flow.sql — the actual redeem/complete path, not just hashing.
-- ============================================================================
\pset tuples_only on
\pset format unaligned

\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set staff_owner '''aaaaaaaa-0000-4000-8000-000000000010'''
\set school_a  '''aaaaaaaa-0000-4000-8000-000000000020'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''
\set child_1   '''aaaaaaaa-0000-4000-8000-000000000050'''
\set guard_new '''cccccccc-0000-4000-8000-000000000001'''

set role app_rw;
select test.as_staff(:studio_a, :staff_owner, 'owner');

insert into claim_code (id, studio_id, child_id, shoot_id, code_hash, code_hint, expires_at)
  values ('cccccccc-0000-4000-8000-000000000010', :studio_a, :child_1, :shoot_a,
          digest('placeholder','sha256'), 'XYZ', now() + interval '7 days');

\echo ''
\echo '── Group 28: the claim flow under system context (0014) ───────────────'
select test.as_system();

-- What completeClaim() actually does, in order: create the guardian, bind
-- them to the child, record consent, burn the code. Before 0014 the third
-- step failed with a bare RLS denial and no earlier signal that it would.
insert into guardian (id, email, full_name) values (:guard_new, 'newparent@test.test', 'New Parent');
select test.ok(true, 'system context can create a guardian account');

insert into guardian_child (studio_id, guardian_id, child_id, relationship, bound_via)
  values (:studio_a, :guard_new, :child_1, 'parent', 'claim_code');
select test.ok(true, 'system context can create the binding');

insert into consent_record (studio_id, child_id, guardian_id, shoot_id, scope,
                            wording_version, locale)
  values (:studio_a, :child_1, :guard_new, :shoot_a, 'service', 'v1.0', 'en');
select test.ok(true, 'system context can record consent — the gap 0014 closes');

update claim_code set redeemed_at = now(), redeemed_by = :guard_new
  where id = 'cccccccc-0000-4000-8000-000000000010';
select test.ok(true, 'system context can burn the code');

\echo ''
\echo '── Group 29: the new guardian sees exactly their child ─────────────────'
select test.as_guardian(:guard_new);
select test.rowcount('select 1 from child where id = ' || quote_literal(:child_1), 1,
                     'the guardian who just claimed sees their child');
select test.rowcount(
  'select 1 from consent_record where guardian_id = ' || quote_literal(:guard_new), 1,
  'the guardian can read the consent record system context wrote on their behalf');

reset role;

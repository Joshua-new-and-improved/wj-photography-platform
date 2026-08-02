-- ============================================================================
-- 0014_claim_flow_gap.sql
--
-- consent_record had exactly one policy: guardian_own_consent, scoped to
-- app.guardian_id() = guardian_id. That is correct for a guardian reading or
-- withdrawing their own consent later, but completeClaim() (src/lib/claim.ts)
-- writes the very first consent_record for a child during redemption, before
-- any guardian session exists — it runs in system context, same as the
-- guardian_child binding and the guardian account creation right beside it.
--
-- Those two already had system policies (system_create_binding,
-- system_create_guardian, migration 0008). consent_record was the one left
-- out, and running the actual claim flow against a live database — rather
-- than only the unit-tested hashing logic in claim.test.ts — is what surfaced
-- it. Same lesson as the missing `studio` policy in Phase 1: a table with RLS
-- on and an incomplete policy set fails silently at runtime, not at review
-- time.
-- ============================================================================

begin;

create policy system_create_consent on consent_record
  for insert with check (app.actor_kind() = 'system');

commit;

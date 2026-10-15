-- 0015 — Parent sessions scoped to children, order contact email, Yoco.
--
-- Until now GET /g/:childId checked nothing: the URL was the only credential.
-- This migration adds what the server needs to close that properly.
--
-- 1. guardian_session.child_scope
--    A session only opens the children whose printed card was entered in that
--    browser. Being bound to a child (guardian_child) is necessary but not
--    sufficient: the browser must ALSO have presented that child's card. That
--    keeps a lost card for one child from revealing a sibling claimed earlier
--    on the same guardian account.
--
-- 2. "order".contact_email
--    Guardians are no longer looked up by the email typed at checkout — doing
--    that let anyone attach an order (and, later, digital downloads) to
--    another parent's account by typing their address. The guardian comes from
--    the session; the typed address is just where to send the receipt.
--
-- Re-runnable: the server applies migrations on boot (src/server/migrate.ts).
--
-- 3. System-context read access to guardian_session, so the session lookup
--    works under app_rw as well as under a superuser connection.

begin;

alter table guardian_session
  add column if not exists child_scope uuid[] not null default '{}';

comment on column guardian_session.child_scope is
  'Children this browser has presented a claim card for. Gallery access requires membership here AND a live guardian_child binding.';

alter table "order"
  add column if not exists contact_email citext;

comment on column "order".contact_email is
  'Receipt address typed at checkout. Never used to identify or authenticate a guardian.';

drop policy if exists system_read_guardian_session on guardian_session;
create policy system_read_guardian_session on guardian_session
  for select using (app.actor_kind() = 'system');

drop policy if exists system_update_guardian_session on guardian_session;
create policy system_update_guardian_session on guardian_session
  for update using (app.actor_kind() = 'system')
  with check (app.actor_kind() = 'system');

commit;

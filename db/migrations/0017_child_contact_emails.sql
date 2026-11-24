-- 0017 — Parent contact emails on the child.
--
-- Studios write the parent's email into the child's folder name
-- ("1. Ioannis parent@example.com"). The importer now separates it from the
-- name and keeps it here, so the studio can see who to contact and so future
-- notifications (gallery ready, order reminders) have an address that came
-- from the school's own list. Collected for the service itself (POPIA s11);
-- never shown to other parents.
--
-- Re-runnable: the server applies migrations on boot.

begin;

alter table child
  add column if not exists contact_emails citext[] not null default '{}';

comment on column child.contact_emails is
  'Parent/guardian emails supplied with the photos (from folder names). Staff-only.';

-- Children imported with only a first name were given "—" as a surname
-- placeholder, which then showed up on pages ("Ioannis —"). Use empty.
update child set last_name = '' where last_name = '—';

commit;

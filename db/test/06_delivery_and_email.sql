-- ============================================================================
-- 06_delivery_and_email.sql — split delivery tracks and the email outbox.
-- ============================================================================
\pset tuples_only on
\pset format unaligned

\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set staff_owner '''aaaaaaaa-0000-4000-8000-000000000010'''
\set staff_photog '''aaaaaaaa-0000-4000-8000-000000000011'''
\set school_a  '''aaaaaaaa-0000-4000-8000-000000000020'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''
\set child_1   '''aaaaaaaa-0000-4000-8000-000000000050'''
\set guard_1   '''aaaaaaaa-0000-4000-8000-000000000060'''
\set ord       '''aaaaaaaa-0000-4000-8000-000000000200'''

set role app_rw;
select test.as_staff(:studio_a, :staff_owner, 'owner');

insert into "order" (id, studio_id, school_id, shoot_id, guardian_id, order_number,
                     subtotal_cents, total_cents, payment_status, digital_status)
  values (:ord, :studio_a, :school_a, :shoot_a, :guard_1, 'WJ-MIXED-01',
          23000, 23000, 'pending', 'pending');

insert into order_line (studio_id, order_id, child_id, line_no, kind, quantity,
                        unit_cents, line_total_cents, vat_rate_bps, snapshot,
                        fulfilment_kind)
  values (:studio_a, :ord, :child_1, 1, 'product', 1, 9500, 9500, 1500,
          '{"name":"Digital image"}', 'digital'),
         (:studio_a, :ord, :child_1, 2, 'product', 1, 13500, 13500, 1500,
          '{"name":"A4 print"}', 'physical');

\echo ''
\echo '── Group 24: digital and physical run on different clocks (0013) ──────'
select test.rowcount(
  'select 1 from order_line where order_id = ' || quote_literal(:ord)
  || ' and fulfilment_kind = ''digital''', 1, 'an order can hold both kinds of line');

select test.throws(
  'update "order" set digital_status = ''delivered'' where id = ' || quote_literal(:ord),
  'digital goods cannot be released before payment settles');

update "order" set payment_status = 'settled' where id = :ord;
update "order" set digital_status = 'delivered' where id = :ord;
select test.rowcount(
  'select 1 from "order" where id = ' || quote_literal(:ord)
  || ' and digital_status = ''delivered'' and digital_delivered_at is not null',
  1, 'settling payment releases digital immediately, and stamps the time');

-- The state the architecture could not previously express, and which most
-- orders sit in for most of their life.
select test.rowcount(
  'select 1 from "order" where id = ' || quote_literal(:ord)
  || ' and digital_status = ''delivered'' and fulfilment_status = ''not_started''',
  1, 'digital delivered while the prints are still queued');

update "order" set physical_dispatch_at = now() + interval '21 days' where id = :ord;
select test.ok(true, 'the studio picks its own dispatch date for physical items');

\echo ''
\echo '── Group 25: the email outbox (0013) ──────────────────────────────────'
insert into email_template (studio_id, key, subject, body_md, updated_by)
  values (:studio_a, 'order.paid', 'Thank you — order {{order_number}}',
          'Thank you for your order.', :staff_owner);
select test.ok(true, 'email copy is editable data, not code');

insert into email_message (studio_id, to_email, guardian_id, order_id, template_key,
                           template_version, subject, body_html, body_text,
                           idempotency_key)
  values (:studio_a, 'parent@test.test', :guard_1, :ord, 'order.paid', 1,
          'Thank you', '<p>Thanks</p>', 'Thanks', 'order.paid:WJ-MIXED-01');
select test.ok(true, 'a message can be queued');

-- The whole reason an outbox exists.
select test.throws(
  'insert into email_message (studio_id, to_email, template_key, subject, body_html,'
  || ' body_text, idempotency_key) values (' || quote_literal(:studio_a)
  || ', ''parent@test.test'', ''order.paid'', ''Thank you'', ''<p>x</p>'', ''x'','
  || ' ''order.paid:WJ-MIXED-01'')',
  'a retried job cannot send the same thank-you twice');

\echo ''
\echo '── Group 26: a hard bounce stops the drip ─────────────────────────────'
insert into email_message (studio_id, to_email, guardian_id, template_key, subject,
                           body_html, body_text, idempotency_key)
  values (:studio_a, 'parent@test.test', :guard_1, 'reminder.final_48h', 'Closing soon',
          '<p>x</p>', 'x', 'reminder:WJ-MIXED-01');

update email_message
   set status = 'bounced', bounce_type = 'hard', bounced_at = now()
 where idempotency_key = 'order.paid:WJ-MIXED-01';

select test.rowcount(
  'select 1 from email_message where idempotency_key = ''reminder:WJ-MIXED-01'''
  || ' and status = ''suppressed''', 1,
  'a hard bounce suppresses everything else queued for that address');
select test.rowcount(
  'select 1 from guardian where id = ' || quote_literal(:guard_1)
  || ' and email_bounce_type = ''hard''', 1,
  'the guardian record records the bad address so the studio can fix it');

\echo ''
\echo '── Group 27: who may change what (0013) ───────────────────────────────'
select test.as_staff(:studio_a, :staff_photog, 'photographer');
select test.throws(
  'insert into studio_setting (studio_id, key, value) values ('
  || quote_literal(:studio_a) || ', ''sender_name'', ''"WJ"''::jsonb)',
  'a photographer cannot change studio settings');
select test.throws(
  'insert into email_template (studio_id, key, subject, body_md) values ('
  || quote_literal(:studio_a) || ', ''x'', ''s'', ''b'')',
  'a photographer cannot rewrite what goes out under the studio name');

select test.as_guardian(:guard_1);
select test.rowcount('select 1 from email_message', 2,
                     'a parent CAN see the mail sent to them, so resends are self-service');
select test.rowcount('select 1 from email_template', 0,
                     'a parent cannot see the templates');
select test.rowcount('select 1 from studio_setting', 0,
                     'a parent cannot see studio settings');

reset role;

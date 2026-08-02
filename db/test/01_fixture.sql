-- ============================================================================
-- 01_fixture.sql
-- Deterministic fixture. Two studios, so cross-tenant isolation is testable;
-- two children in one class with a shared class photo, so the many-to-many
-- gallery model of §2.3 is testable; one suppressed child, so §2.4 is testable.
--
-- Runs as the owner (RLS not yet in play) to seed. Every assertion afterwards
-- runs as app_rw under a real session context.
-- ============================================================================

-- Fixed UUIDs so failures name a recognisable row rather than a random one.
\set studio_a  '''aaaaaaaa-0000-4000-8000-000000000001'''
\set studio_b  '''bbbbbbbb-0000-4000-8000-000000000001'''

\set staff_owner  '''aaaaaaaa-0000-4000-8000-000000000010'''
\set staff_photog '''aaaaaaaa-0000-4000-8000-000000000011'''
\set staff_asst   '''aaaaaaaa-0000-4000-8000-000000000012'''
\set staff_b      '''bbbbbbbb-0000-4000-8000-000000000010'''

\set school_a  '''aaaaaaaa-0000-4000-8000-000000000020'''
\set school_b  '''bbbbbbbb-0000-4000-8000-000000000020'''
\set grade_a   '''aaaaaaaa-0000-4000-8000-000000000030'''
\set class_a   '''aaaaaaaa-0000-4000-8000-000000000031'''
\set shoot_a   '''aaaaaaaa-0000-4000-8000-000000000040'''

\set child_1   '''aaaaaaaa-0000-4000-8000-000000000050'''
\set child_2   '''aaaaaaaa-0000-4000-8000-000000000051'''
\set child_sup '''aaaaaaaa-0000-4000-8000-000000000052'''
\set child_b   '''bbbbbbbb-0000-4000-8000-000000000050'''

\set guard_1   '''aaaaaaaa-0000-4000-8000-000000000060'''
\set guard_2   '''aaaaaaaa-0000-4000-8000-000000000061'''

\set asset_p1  '''aaaaaaaa-0000-4000-8000-000000000070'''
\set asset_p2  '''aaaaaaaa-0000-4000-8000-000000000071'''
\set asset_cls '''aaaaaaaa-0000-4000-8000-000000000072'''

insert into studio (id, name, vat_number) values
  (:studio_a, 'Studio A', '4123456789'),
  (:studio_b, 'Studio B', null);

insert into staff_user (id, studio_id, email, full_name, role, status, mfa_enabled) values
  (:staff_owner,  :studio_a, 'owner@a.test',  'A Owner',        'owner',        'active', true),
  (:staff_photog, :studio_a, 'photog@a.test', 'A Photographer', 'photographer', 'active', false),
  (:staff_asst,   :studio_a, 'asst@a.test',   'A Assistant',    'assistant',    'active', false),
  (:staff_b,      :studio_b, 'owner@b.test',  'B Owner',        'owner',        'active', true);

insert into school (id, studio_id, name, code, agreement_signed_at,
                    agreement_expires_at, agreement_covers_group_photos) values
  (:school_a, :studio_a, 'Laerskool Alfa', 'LA', now() - interval '30 days',
   now() + interval '300 days', true),
  (:school_b, :studio_b, 'Beta Primary',   'BP', now() - interval '30 days',
   now() + interval '300 days', false);

-- A school with no signed agreement, to prove the shoot gate in §3.3.
insert into school (id, studio_id, name, code) values
  ('aaaaaaaa-0000-4000-8000-000000000021', :studio_a, 'Laerskool Gamma', 'LG');

insert into grade (id, studio_id, school_id, name, name_norm) values
  (:grade_a, :studio_a, :school_a, 'Graad R', 'grade r');

insert into class_group (id, studio_id, school_id, grade_id, name, name_norm, academic_year) values
  (:class_a, :studio_a, :school_a, :grade_a, 'A', 'a', 2026);

insert into shoot (id, studio_id, school_id, name, kind, academic_year, shoot_date,
                   gallery_opens_at, order_deadline_at, status) values
  (:shoot_a, :studio_a, :school_a, 'Familie Fotos 2026', 'family', 2026, current_date,
   now() - interval '1 day', now() + interval '14 days', 'open');

insert into child (id, studio_id, school_id, first_name, last_name) values
  (:child_1, :studio_a, :school_a, 'Zané',  'Botha'),
  (:child_2, :studio_a, :school_a, 'Pieter', 'Botha'),
  (:child_b, :studio_b, :school_b, 'Thabo',  'Nkosi');

-- A child who must not be published (§2.4).
insert into child (id, studio_id, school_id, first_name, last_name,
                   suppression_status, suppression_set_at) values
  (:child_sup, :studio_a, :school_a, 'Suppressed', 'Child', 'no_publication', now());

insert into enrolment (studio_id, child_id, class_group_id, academic_year) values
  (:studio_a, :child_1, :class_a, 2026),
  (:studio_a, :child_2, :class_a, 2026);

insert into guardian (id, email, full_name) values
  (:guard_1, 'guardian1@test.test', 'Guardian One'),
  (:guard_2, 'guardian2@test.test', 'Guardian Two');

-- Guardian One is bound to child 1 only. Guardian Two to child 2 only.
insert into guardian_child (studio_id, guardian_id, child_id, relationship, bound_via) values
  (:studio_a, :guard_1, :child_1, 'parent', 'claim_code'),
  (:studio_a, :guard_2, :child_2, 'parent', 'claim_code');

insert into consent_record (studio_id, child_id, guardian_id, shoot_id, scope,
                            wording_version, locale) values
  (:studio_a, :child_1, :guard_1, :shoot_a, 'service', 'v1.0', 'en'),
  (:studio_a, :child_2, :guard_2, :shoot_a, 'service', 'v1.0', 'en');

-- Three assets: one portrait each, plus a class photo shared between them.
insert into asset (id, studio_id, shoot_id, sha256, storage_key, bytes, width, height,
                   content_type, captured_at, status) values
  (:asset_p1,  :studio_a, :shoot_a, digest('p1','sha256'),  'k/p1',  1200000, 4000, 6000,
   'image/jpeg', now(), 'ready'),
  (:asset_p2,  :studio_a, :shoot_a, digest('p2','sha256'),  'k/p2',  1200000, 4000, 6000,
   'image/jpeg', now(), 'ready'),
  (:asset_cls, :studio_a, :shoot_a, digest('cls','sha256'), 'k/cls', 1800000, 6000, 4000,
   'image/jpeg', now(), 'ready');

insert into asset_variant (asset_id, studio_id, kind, format, storage_key,
                           width, height, bytes, watermarked) values
  (:asset_p1,  :studio_a, 'thumb',   'avif', 'k/p1.thumb',   400, 600,  22000, true),
  (:asset_p1,  :studio_a, 'preview', 'avif', 'k/p1.preview', 800, 1200, 110000, true),
  (:asset_p1,  :studio_a, 'print',   'jpeg', 'k/p1.print',   4000, 6000, 9000000, false),
  (:asset_p2,  :studio_a, 'thumb',   'avif', 'k/p2.thumb',   400, 600,  22000, true),
  (:asset_cls, :studio_a, 'thumb',   'avif', 'k/cls.thumb',  600, 400,  24000, true);

-- The many-to-many case: the class photo is in both children's galleries (§2.3).
insert into gallery_item (studio_id, asset_id, child_id, role, assigned_by, confidence) values
  (:studio_a, :asset_p1,  :child_1, 'individual', 'slate', 1.00),
  (:studio_a, :asset_p2,  :child_2, 'individual', 'slate', 1.00),
  (:studio_a, :asset_cls, :child_1, 'class',      'bulk',  1.00),
  (:studio_a, :asset_cls, :child_2, 'class',      'bulk',  1.00);

-- Catalogue, priced.
insert into print_size (id, studio_id, label, width_mm, height_mm) values
  ('aaaaaaaa-0000-4000-8000-000000000080', :studio_a, '10x15', 100, 150),
  ('aaaaaaaa-0000-4000-8000-000000000081', :studio_a, 'A4',    210, 297);

insert into product (id, studio_id, sku, name_i18n, kind, active) values
  ('aaaaaaaa-0000-4000-8000-000000000090', :studio_a, 'PRINT-STD',
   '{"en":"Print"}', 'print', true);

insert into price_list (id, studio_id, name, effective_from, status) values
  ('aaaaaaaa-0000-4000-8000-0000000000a0', :studio_a, '2026 Term 3',
   now() - interval '1 day', 'published');

insert into price (studio_id, price_list_id, product_id, amount_cents) values
  (:studio_a, 'aaaaaaaa-0000-4000-8000-0000000000a0',
   'aaaaaaaa-0000-4000-8000-000000000090', 8500);

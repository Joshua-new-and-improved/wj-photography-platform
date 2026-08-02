-- ============================================================================
-- 0012_english_only.sql
--
-- The studio wants the product in English only.
--
-- Bilingual copy was my addition, not a requirement — §2.12 argued for it from
-- the Afrikaans reference slip and the Afrikaans-medium schools in the client
-- list. That reasoning was about the market, not about what was asked for, and
-- the studio has decided. English it is.
--
-- What changes: every default locale, and the constraint that forced a catalogue
-- entry to carry both languages. That constraint would now block a normal
-- English-only product from being saved at all.
--
-- What does NOT change: the i18n columns stay jsonb keyed by locale. Collapsing
-- them to plain text columns would save nothing measurable and would make a
-- future second language a schema migration across the catalogue rather than a
-- data change. The mechanism costs nothing dormant; ripping it out costs
-- something to put back.
-- ============================================================================

begin;

alter table studio     alter column default_locale set default 'en';
alter table school     alter column locale set default 'en';
alter table guardian   alter column locale set default 'en';
alter table staff_user alter column locale set default 'en';

update studio     set default_locale = 'en';
update school     set locale = 'en';
update guardian   set locale = 'en';
update staff_user set locale = 'en';

-- Catalogue entries must carry English. Any other locale is optional extra.
alter table product drop constraint product_name_has_locales;
alter table product add constraint product_name_has_english
  check (name_i18n ? 'en');

alter table package drop constraint package_name_has_locales;
alter table package add constraint package_name_has_english
  check (name_i18n ? 'en');

comment on column product.name_i18n is
  'Locale-keyed name. English required; other locales optional and currently unused.';
comment on column package.name_i18n is
  'Locale-keyed name. English required; other locales optional and currently unused.';

commit;

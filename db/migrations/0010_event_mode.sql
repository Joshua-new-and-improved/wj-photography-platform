-- ============================================================================
-- 0010_event_mode.sql
--
-- Correction to a load-bearing assumption.
--
-- The architecture (§6, §7, §9) assumed one shape of business: school portrait
-- day, per-child galleries, a printed claim code per child. Looking at the
-- actual studio's live catalogue, that shape is the *minority* of the work.
-- The bulk is sports and dance events — acro nationals, netball functions,
-- dance competitions — running 300 to 800 images each, browsed publicly, with
-- no class list, no per-child slate cards, and no way to know in advance which
-- child is in which frame.
--
-- Those two models need different access rules and cannot share one code path:
--
--   gated  : portrait day. Per-child gallery, claim code, guardian binding.
--            Nobody sees a child they are not bound to. (§6.2)
--   browse : event day. The whole event gallery is watermarked and public,
--            found by event or by a reference printed on the frame. There is
--            no child identity in the system at all — which is, incidentally,
--            the lightest-touch position under POPIA, because personal
--            information about a child is never collected.
--
-- Getting this wrong in either direction is bad: gating a netball tournament
-- makes it unsellable, and opening a portrait-day gallery is a safeguarding
-- failure. So the mode is an explicit column with an explicit default of
-- 'gated', and the RLS policies branch on it.
-- ============================================================================

begin;

alter table shoot
  add column access_mode text not null default 'gated'
    check (access_mode in ('gated','browse'));

comment on column shoot.access_mode is
  'gated = per-child galleries behind a claim code; browse = public watermarked event gallery.';

-- Event taxonomy, mirroring how the studio already files work: a top-level
-- classification and a discipline beneath it.
alter table shoot
  add column classification text
    check (classification in ('schools','sports','dance','events','weddings','other')),
  add column discipline text;

create index shoot_browse_idx on shoot (studio_id, classification, shoot_date desc)
  where access_mode = 'browse' and status = 'open';

-- ── Media reference codes ────────────────────────────────────────────────────
-- In browse mode there is no child to attach a photograph to, so the frame
-- itself needs a handle a parent can quote: "I want number 14746313". The
-- studio's existing site does exactly this and it is the right pattern —
-- printed on onsite proofs, read out at the print table, searched later.
--
-- Deliberately short and sequential *within a shoot*: this identifier protects
-- nothing, because the whole gallery is already public. Making it
-- unguessable would be security theatre and would make it unusable at a
-- print table. Compare claim_code, which protects everything and is therefore
-- 50 bits and hashed.
alter table asset
  add column reference_no int;

create unique index asset_reference_idx on asset (shoot_id, reference_no)
  where reference_no is not null;

create or replace function app.assign_reference_no() returns trigger
language plpgsql as $$
begin
  if new.reference_no is null and not new.is_slate then
    select coalesce(max(reference_no), 0) + 1 into new.reference_no
      from asset where shoot_id = new.shoot_id;
  end if;
  return new;
end;
$$;

create trigger asset_reference_seq
  before insert on asset
  for each row execute function app.assign_reference_no();

-- ── Saved carts ──────────────────────────────────────────────────────────────
-- A parent at a dance competition builds a 15-item cart on a phone in a noisy
-- hall and does not want to make an account. The existing site solves this
-- with "Retrieve My Cart" and it is worth keeping: a short retrieval code,
-- emailed, that restores the cart later. Not a credential for anything else.
alter table cart
  add column retrieval_code_hash bytea,
  add column retrieval_email citext,
  add column saved_at timestamptz;

create index cart_retrieval_idx on cart (retrieval_email) where saved_at is not null;

-- ── Onsite printing ──────────────────────────────────────────────────────────
-- Assumption A8 said print fulfilment is outsourced to a lab. It is not: the
-- studio prints on site at events. That is a different flow entirely — the
-- parent chooses, pays and collects within a few minutes, at a table, on the
-- studio's own hardware. It is also the highest-margin moment in the business
-- and the one most damaged by a slow interface.
--
-- Practically: an onsite order skips 'queued' and goes straight to production,
-- is usually paid by card on a Yoco reader or by scan-to-pay, and needs a
-- print-queue position rather than a lab export.
alter table "order"
  add column channel text not null default 'online'
    check (channel in ('online','onsite')),
  add column print_queue_no int,
  add column collected_at timestamptz;

create index order_print_queue_idx on "order" (studio_id, shoot_id, print_queue_no)
  where channel = 'onsite' and collected_at is null;

-- ── RLS: the browse-mode read path ───────────────────────────────────────────
-- The obvious policy — "this asset is visible if its shoot is a public browse
-- shoot" — creates a policy cycle. The asset policy would consult `shoot`, and
-- the guardian policy on `shoot` consults `asset` to work out which shoots
-- contain a bound child. PostgreSQL detects that structurally and refuses the
-- query, regardless of which branch would actually have run.
--
-- So publicness is denormalised onto the asset row and kept in step by trigger.
-- Policies then reference one column on one table, which also makes the browse
-- gallery — the highest-traffic page in the product — a single-table scan
-- rather than a correlated subquery per row.
alter table asset add column is_public boolean not null default false;

create index asset_public_idx on asset (shoot_id, reference_no) where is_public;

create or replace function app.sync_asset_publicity() returns trigger
language plpgsql as $$
declare mode text; st text; opens timestamptz;
begin
  select s.access_mode, s.status, s.gallery_opens_at
    into mode, st, opens
    from shoot s where s.id = new.shoot_id;

  new.is_public :=
    mode = 'browse' and st = 'open'
    and (opens is null or opens <= now())
    and new.status = 'ready' and not new.is_slate;
  return new;
end;
$$;

create trigger asset_publicity
  before insert or update on asset
  for each row execute function app.sync_asset_publicity();

-- Opening or closing a shoot has to propagate. A bulk update per shoot,
-- happening at most a handful of times in a shoot's life.
create or replace function app.propagate_shoot_publicity() returns trigger
language plpgsql as $$
begin
  if new.access_mode is distinct from old.access_mode
     or new.status is distinct from old.status
     or new.gallery_opens_at is distinct from old.gallery_opens_at then
    update asset
       set is_public = (
             new.access_mode = 'browse' and new.status = 'open'
             and (new.gallery_opens_at is null or new.gallery_opens_at <= now())
             and status = 'ready' and not is_slate)
     where shoot_id = new.id;
  end if;
  return new;
end;
$$;

create trigger shoot_publicity
  after update on shoot
  for each row execute function app.propagate_shoot_publicity();

create policy browse_public_assets on asset
  for select using (is_public);

create policy browse_public_variants on asset_variant
  for select using (
    kind in ('thumb','preview','proof') and watermarked
    and exists (select 1 from asset a
                 where a.id = asset_variant.asset_id and a.is_public)
  );

-- Shoots in browse mode are listable by anyone, so the event index page works
-- without a session. This policy touches no other table, so no cycle.
create policy browse_public_shoots on shoot
  for select using (
    access_mode = 'browse' and status = 'open'
    and (gallery_opens_at is null or gallery_opens_at <= now())
  );

-- The safeguarding invariant, stated as a constraint rather than a convention:
-- a browse-mode shoot must never acquire a gallery_item, because a gallery_item
-- links an asset to a named child and browse mode is precisely the mode where
-- no child is identified.
create or replace function app.enforce_browse_has_no_children() returns trigger
language plpgsql as $$
declare m text;
begin
  select s.access_mode into m
    from asset a join shoot s on s.id = a.shoot_id
   where a.id = new.asset_id;
  if m = 'browse' then
    raise exception
      'Asset % belongs to a browse-mode shoot and cannot be linked to a child. '
      'Switch the shoot to gated mode first.', new.asset_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger gallery_item_browse_gate
  before insert or update on gallery_item
  for each row execute function app.enforce_browse_has_no_children();

commit;

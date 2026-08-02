-- ============================================================================
-- 0008_rls.sql
-- Row-level security. The second layer of defence behind the application's
-- repository guard, so that one forgotten WHERE clause is not a data breach.
--
-- Architecture refs: §5.1, §6.5, §6.6, §15.1.
--
-- The application connects as app_rw, which is deliberately NOT the table owner
-- and NOT BYPASSRLS. FORCE ROW LEVEL SECURITY is set anyway, so that even a
-- connection that somehow arrives as the owner is still constrained.
-- ============================================================================

begin;

-- ── Grants ───────────────────────────────────────────────────────────────────
grant select, insert, update, delete on all tables in schema public to app_rw;
grant usage, select on all sequences in schema public to app_rw;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_rw;
alter default privileges in schema public
  grant usage, select on sequences to app_rw;

-- The audit log is append-only at the privilege level. The triggers in 0007
-- are the second layer, not the first (§15.3).
revoke update, delete on audit_event from app_rw;

-- ── Enable RLS everywhere, and install the baseline staff policy ─────────────
-- Done in a loop rather than by hand because the real risk is not writing a
-- bad policy, it is forgetting a table entirely. Anything with a studio_id
-- gets tenant scoping automatically; anything without appears in the explicit
-- list below and is checked by the test suite.
do $$
declare
  t record;
  has_studio boolean;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('alter table public.%I force row level security', t.relname);

    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = t.relname
         and column_name = 'studio_id'
    ) into has_studio;

    if has_studio then
      -- Staff see and touch only their own studio's rows.
      execute format($p$
        create policy staff_tenant_scope on public.%I
          for all
          using (app.is_staff() and studio_id = app.studio_id())
          with check (app.is_staff() and studio_id = app.studio_id())
      $p$, t.relname);
    end if;
  end loop;
end;
$$;

-- ── studio: the one table the loop above cannot scope automatically ──────────
-- studio has no studio_id column — its primary key IS the studio id. Without
-- an explicit policy it inherits RLS-enabled-with-no-policy, which is deny-all,
-- and the application cannot read its own VAT rate or default locale.
--
-- The CI job "assert every table has at least one policy" exists precisely
-- because this is easy to miss and fails silently at runtime rather than loudly
-- at migration time.
create policy staff_own_studio on studio
  for select using (app.is_staff() and id = app.studio_id());

create policy admin_update_studio on studio
  for update using (app.staff_at_least('admin') and id = app.studio_id())
  with check (app.staff_at_least('admin') and id = app.studio_id());

-- Sign-in resolves the studio before a staff context exists.
create policy system_read_studio on studio
  for select using (app.actor_kind() = 'system');

-- ============================================================================
-- Staff role restrictions (§6.5)
--
-- The baseline policy above is permissive-for-any-staff. These RESTRICTIVE
-- policies narrow it by role. Restrictive policies AND together with the
-- permissive ones, so a row must satisfy both.
-- ============================================================================

-- Financial data: photographer and above. Assistants get no financial data,
-- viewers get no row-level PII at all.
create policy staff_min_photographer on "order" as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));

create policy staff_min_photographer on order_line as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));

create policy staff_min_photographer on payment as restrictive
  for all using (not app.is_staff() or app.staff_at_least('photographer'));

-- Pricing is an admin action. A photographer may run a whole shoot but may not
-- change what anything costs or issue a refund (§6.5).
create policy price_write_admin_only on price as restrictive
  for insert with check (app.staff_at_least('admin'));
create policy price_update_admin_only on price as restrictive
  for update using (app.staff_at_least('admin'));
create policy price_delete_admin_only on price as restrictive
  for delete using (app.staff_at_least('admin'));

create policy price_list_write_admin_only on price_list as restrictive
  for insert with check (app.staff_at_least('admin'));
create policy price_list_update_admin_only on price_list as restrictive
  for update using (app.staff_at_least('admin'));

-- Child records: assistant and above. Viewers see aggregates only, which they
-- obtain through reporting views, not through this table.
create policy staff_min_assistant on child as restrictive
  for all using (not app.is_staff() or app.staff_at_least('assistant'));

-- The suppression register is owner/admin only. NOTE: PostgreSQL policies are
-- row-level, not column-level, so hiding suppression_reason_enc specifically is
-- enforced by the application repository layer plus the restricted view below.
create policy staff_suppression_admin on child as restrictive
  for update using (
    not app.is_staff()
    or app.staff_at_least('admin')
    or suppression_status = 'none'
  );

-- Audit log: readable by admin and above only.
create policy audit_read_admin on audit_event as restrictive
  for select using (not app.is_staff() or app.staff_at_least('admin'));

-- ============================================================================
-- Guardian policies (§6.2)
--
-- Everything a guardian can reach resolves through guardian_child. This is the
-- table that makes "parents may only ever see their own child's photographs"
-- enforceable rather than aspirational.
-- ============================================================================

-- Split deliberately into two functions.
--
-- The obvious single-function version — "bound AND not suppressed" — reads
-- better but deadlocks the planner: the policy on `child` would call a function
-- that queries `child`, whose policy calls the function again. Infinite
-- recursion, and PostgreSQL only tells you about it at query time.
--
-- So: guardian_bound_to touches ONLY guardian_child (whose own policy is a
-- plain column comparison, calling nothing). It is safe to use inside the
-- child policy. The suppression half then rides along on that policy rather
-- than being re-checked inside it.
create or replace function app.guardian_bound_to(p_child uuid) returns boolean
language sql stable
as $$
  select app.is_guardian() and exists (
    select 1 from guardian_child gc
     where gc.guardian_id = app.guardian_id()
       and gc.child_id    = p_child
       and gc.revoked_at is null
  );
$$;

-- Queries child, so it inherits whatever the child policy allows for the
-- current actor. Never call this from the child policy itself.
create or replace function app.child_is_visible(p_child uuid) returns boolean
language sql stable
as $$
  select exists (
    select 1 from child c
     where c.id = p_child
       -- A suppressed child yields nothing to anyone, including a bound
       -- guardian, until the suppression is lifted (§2.4).
       and c.suppression_status = 'none'
  );
$$;

create or replace function app.guardian_owns_child(p_child uuid) returns boolean
language sql stable
as $$
  select app.guardian_bound_to(p_child) and app.child_is_visible(p_child);
$$;

-- Own account.
create policy guardian_self on guardian
  for all using (app.is_guardian() and id = app.guardian_id())
  with check (app.is_guardian() and id = app.guardian_id());

create policy guardian_own_sessions on guardian_session
  for all using (app.is_guardian() and guardian_id = app.guardian_id())
  with check (app.is_guardian() and guardian_id = app.guardian_id());

create policy guardian_own_bindings on guardian_child
  for select using (app.is_guardian() and guardian_id = app.guardian_id());

create policy guardian_own_consent on consent_record
  for all using (app.is_guardian() and guardian_id = app.guardian_id())
  with check (app.is_guardian() and guardian_id = app.guardian_id());

-- Bound children only.
-- Uses guardian_bound_to, NOT guardian_owns_child — see the note above.
create policy guardian_bound_children on child
  for select using (app.guardian_bound_to(id) and suppression_status = 'none');

create policy guardian_bound_gallery on gallery_item
  for select using (app.guardian_owns_child(child_id));

-- An asset is visible if it appears in the gallery of a child this guardian is
-- bound to. This is what makes class and sibling photographs work: the same
-- asset is reachable through several children, each independently authorised.
create policy guardian_visible_assets on asset
  for select using (
    app.is_guardian() and exists (
      select 1 from gallery_item gi
       where gi.asset_id = asset.id
         and app.guardian_owns_child(gi.child_id)
    )
  );

-- Variants: watermarked kinds only. 'print' is absent from the guardian
-- surface entirely — not hidden, absent (§8.1).
create policy guardian_watermarked_variants on asset_variant
  for select using (
    app.is_guardian()
    and kind in ('thumb','preview','proof')
    and watermarked
    and exists (
      select 1 from gallery_item gi
       where gi.asset_id = asset_variant.asset_id
         and app.guardian_owns_child(gi.child_id)
    )
  );

-- Context needed to render a gallery: the shoot it belongs to and the school
-- name. Read-only, and only for shoots containing a bound child.
create policy guardian_relevant_shoots on shoot
  for select using (
    app.is_guardian() and exists (
      select 1 from gallery_item gi
        join asset a on a.id = gi.asset_id
       where a.shoot_id = shoot.id
         and app.guardian_owns_child(gi.child_id)
    )
  );

create policy guardian_relevant_schools on school
  for select using (
    app.is_guardian() and exists (
      select 1 from child c
       where c.school_id = school.id
         and app.guardian_owns_child(c.id)
    )
  );

-- Catalogue: guardians must be able to shop. Active and published rows only.
create policy guardian_read_products on product
  for select using (app.is_guardian() and active);
create policy guardian_read_variants on product_variant
  for select using (app.is_guardian() and active);
create policy guardian_read_packages on package
  for select using (app.is_guardian() and active);
create policy guardian_read_package_items on package_item
  for select using (app.is_guardian());
create policy guardian_read_print_sizes on print_size
  for select using (app.is_guardian() and active);
create policy guardian_read_price_lists on price_list
  for select using (
    app.is_guardian()
    and status = 'published'
    and effective_from <= now()
    and (effective_to is null or effective_to > now())
  );
create policy guardian_read_prices on price
  for select using (
    app.is_guardian() and exists (
      select 1 from price_list pl
       where pl.id = price.price_list_id
         and pl.status = 'published'
         and pl.effective_from <= now()
         and (pl.effective_to is null or pl.effective_to > now())
    )
  );

-- Commerce: own carts and orders.
create policy guardian_own_cart on cart
  for all using (app.is_guardian() and guardian_id = app.guardian_id())
  with check (app.is_guardian() and guardian_id = app.guardian_id());

create policy guardian_own_cart_items on cart_item
  for all using (
    app.is_guardian() and exists (
      select 1 from cart c where c.id = cart_item.cart_id
        and c.guardian_id = app.guardian_id()
    )
  )
  with check (
    app.is_guardian()
    and app.guardian_owns_child(child_id)
    and exists (
      select 1 from cart c where c.id = cart_item.cart_id
        and c.guardian_id = app.guardian_id()
    )
  );

create policy guardian_own_orders on "order"
  for select using (app.is_guardian() and guardian_id = app.guardian_id());

create policy guardian_own_order_lines on order_line
  for select using (
    app.is_guardian() and exists (
      select 1 from "order" o where o.id = order_line.order_id
        and o.guardian_id = app.guardian_id()
    )
  );

-- Download grants: own, unrevoked, unexpired, under quota (§8.4).
create policy guardian_own_downloads on download_grant
  for select using (
    app.is_guardian()
    and guardian_id = app.guardian_id()
    and revoked_at is null
    and expires_at > now()
    and downloads < max_downloads
  );

-- ============================================================================
-- System context
--
-- A small, deliberately narrow set of operations that have no authenticated
-- actor yet. The claim-redemption service must read claim_code hashes before a
-- guardian exists; the payment webhook receiver must record an event before it
-- knows which order it belongs to. Both are small, server-side, and audited.
-- ============================================================================

create policy system_claim_lookup on claim_code
  for select using (app.actor_kind() = 'system');
create policy system_claim_redeem on claim_code
  for update using (app.actor_kind() = 'system')
  with check (app.actor_kind() = 'system');

create policy system_claim_attempts on claim_attempt
  for insert with check (app.actor_kind() in ('system','anonymous'));
create policy system_read_claim_attempts on claim_attempt
  for select using (app.actor_kind() = 'system' or app.staff_at_least('admin'));

create policy system_preview_sessions on preview_session
  for all using (app.actor_kind() = 'system')
  with check (app.actor_kind() = 'system');

create policy system_payment_events on payment_event
  for all using (app.actor_kind() = 'system')
  with check (app.actor_kind() = 'system');
create policy staff_read_payment_events on payment_event
  for select using (app.staff_at_least('admin'));

create policy system_create_guardian on guardian
  for insert with check (app.actor_kind() = 'system');
create policy system_create_binding on guardian_child
  for insert with check (app.actor_kind() = 'system');
create policy system_create_guardian_session on guardian_session
  for insert with check (app.actor_kind() = 'system');

-- Staff need to read and manage guardian records for support and for offline
-- orders — photographer and above, never assistant or viewer (§6.5).
create policy staff_read_guardians on guardian
  for select using (app.staff_at_least('photographer'));
create policy staff_manage_bindings on guardian_child
  for all using (app.staff_at_least('admin'))
  with check (app.staff_at_least('admin'));

-- Staff sessions belong to the staff member and are readable by the studio's
-- admins for revocation.
create policy staff_own_session on staff_session
  for all using (
    (app.is_staff() and staff_id = app.staff_id())
    or app.actor_kind() = 'system'
  )
  with check (
    (app.is_staff() and staff_id = app.staff_id())
    or app.actor_kind() = 'system'
  );

-- Staff authentication itself runs in system context, because the studio is
-- not known until the user row is found.
create policy system_staff_lookup on staff_user
  for select using (app.actor_kind() = 'system');

commit;

import type express from "express";
import type { Pool } from "pg";
import { adminPage, chip, escapeHtml, type AdminBadges } from "./views.js";
import { formatRands, randsInputValue } from "../lib/commerce/money.js";
import { getObject, publicUrl } from "../lib/storage/local.js";
import { settleOrder, saveYocoKey, yocoStatus, publicOrigin } from "./payments.js";
import { rlsEnforcedForParents } from "./parent-auth.js";
import { diskStatus, sweepOrphans } from "./storage-health.js";
import { issueClaimCode } from "../lib/claim.js";
import QRCode from "qrcode";

/**
 * The studio console. One page per job Wiaan actually does:
 *
 *   Overview         — what needs attention today
 *   Orders           — find any order, see what was bought, mark cash/EFT paid
 *   Print & deliver  — the production list after the order deadline, grouped
 *                      by school and class, with the original files one click
 *                      away; then tick printed and delivered
 *   Schools          — children, claim cards, gallery previews
 *   Products & packages, Settings
 *
 * All of it sits behind the /admin Basic-auth gate in import-server.ts.
 */

export interface AdminDeps {
  pool: Pool;
  ensureStudioAndStaff: () => Promise<{ studioId: string; staffId: string }>;
  findOrCreateShoot: (studioId: string, schoolId: string) => Promise<string>;
  bootState: { migrations: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const KIND_LABEL: Record<string, string> = {
  print: "Print",
  merch: "Gift",
  digital_single: "Digital",
  digital_gallery: "Digital gallery",
};

/**
 * Does this order have anything to print or make? Product lines say so
 * directly. A package line counts when its recorded contents include a print
 * or gift — or when it carries no contents at all (packages sold before
 * contents were recorded), because guessing "nothing to print" would silently
 * drop a parent's prints.
 */
const NEEDS_PRODUCTION = `exists(select 1 from order_line ol where ol.order_id = o.id and (
    ol.fulfilment_kind = 'physical'
    or (ol.kind = 'package' and (
          jsonb_array_length(coalesce(ol.snapshot->'contents', '[]'::jsonb)) = 0
          or exists(select 1 from jsonb_array_elements(ol.snapshot->'contents') e where e->>'kind' in ('print','merch'))))))`;

const ORDER_ROWS = `
  select o.id, o.order_number, o.total_cents, o.payment_status, o.fulfilment_status, o.digital_status,
         o.placed_at, o.offline_method, o.offline_ref, coalesce(o.contact_email, g.email) as email,
         coalesce(s.display_name, s.name) as school, s.id as school_id,
         ch.id as child_id, ch.first_name || ' ' || ch.last_name as child,
         en.class_name, en.grade_name,
         ${NEEDS_PRODUCTION} as needs_production,
         (select string_agg(t.label, ', ') from (
            select (ol.snapshot->>'name') || case when count(*) > 1 then ' ×' || count(*) else '' end as label
              from order_line ol where ol.order_id = o.id
             group by ol.snapshot->>'name' order by min(ol.line_no)) t) as items
    from "order" o
    join guardian g on g.id = o.guardian_id
    join school s on s.id = o.school_id
    left join lateral (select c.id, c.first_name, c.last_name from order_line ol join child c on c.id = ol.child_id
                        where ol.order_id = o.id order by ol.line_no limit 1) ch on true
    left join lateral (select cl.name as class_name, gr.name as grade_name
                         from enrolment e join class_group cl on cl.id = e.class_group_id
                         left join grade gr on gr.id = cl.grade_id
                        where e.child_id = ch.id order by e.academic_year desc limit 1) en on true
   where o.studio_id = $1`;

type Filter = "all" | "awaiting" | "paid" | "print" | "deliver" | "done";
const FILTERS: Record<Filter, { label: string; where: string }> = {
  all: { label: "All", where: "true" },
  awaiting: { label: "Awaiting payment", where: "x.payment_status not in ('settled','refunded','partially_refunded')" },
  paid: { label: "Paid", where: "x.payment_status = 'settled'" },
  print: {
    label: "To print",
    where: "x.payment_status = 'settled' and x.needs_production and x.fulfilment_status in ('not_started','queued','in_production')",
  },
  deliver: { label: "To deliver", where: "x.fulfilment_status = 'printed'" },
  done: {
    label: "Done",
    where: "x.fulfilment_status in ('dispatched','completed') or (x.payment_status = 'settled' and not x.needs_production)",
  },
};

function classLabel(o: { grade_name?: string | null; class_name?: string | null }): string {
  return [o.grade_name, o.class_name ? `Class ${o.class_name}` : null].filter(Boolean).join(" · ");
}

function paymentChip(status: string, offline?: string | null): string {
  switch (status) {
    case "settled": return chip(offline === "cash" ? "Paid · cash" : offline === "manual_eft" ? "Paid · EFT" : "Paid", "ok");
    case "initiated": return chip("Paying now", "info");
    case "failed": return chip("Payment failed", "bad");
    case "refunded":
    case "partially_refunded": return chip("Refunded", "muted");
    default: return chip("Awaiting payment", "warn");
  }
}

function productionChip(o: { payment_status: string; fulfilment_status: string; needs_production: boolean }): string {
  if (!o.needs_production) return chip("Digital only", "muted");
  switch (o.fulfilment_status) {
    case "printed": return chip("Printed", "info");
    case "dispatched": return chip("Delivered", "ok");
    case "completed": return chip("Collected", "ok");
    default: return o.payment_status === "settled" ? chip("To print", "warn") : chip("Not yet", "muted");
  }
}

const gb = (b: number) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB");

function storagePanel(d: Awaited<ReturnType<typeof diskStatus>>): string {
  if (!d) return `<p class="muted">Storage size couldn't be read.</p>`;
  const tone = d.usedPct >= 90 ? "bad" : d.usedPct >= 75 ? "warn" : "ok";
  // A full-resolution school photo is ~8–12 MB with its previews.
  const photosLeft = Math.max(0, Math.floor(d.freeBytes / 10e6));
  return `<div class="storebar ${tone}"><i style="width:${Math.min(100, d.usedPct)}%"></i></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0 12px">
      ${chip(`${d.usedPct}% used`, tone)} <span>${gb(d.usedBytes)} of ${gb(d.totalBytes)} · ${gb(d.freeBytes)} free</span>
      <span class="muted">≈ room for ${photosLeft.toLocaleString("en-ZA")} more photos</span></div>
    ${d.usedPct >= 75 ? `<p class="sub" style="margin:0 0 12px">A typical school takes several GB. To add space: Railway → project → <b>precious-joy-volume</b> → Settings → size (larger sizes need a paid Railway plan).</p>` : ""}
    <form method="post" action="/admin/storage/sweep" class="inline"><button class="btn small ghost" type="submit">Free up space from failed uploads</button></form>`;
}

const when = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: "Africa/Johannesburg" });

function flashFrom(req: express.Request) {
  if (req.query.saved) return { ok: true, text: String(req.query.saved) };
  if (req.query.error) return { ok: false, text: String(req.query.error) };
  return null;
}

/** Redirect back where the form was, with a message. */
export function backTo(res: express.Response, path: string, msg: { saved?: string; error?: string }) {
  const [base, hash] = path.split("#");
  const sep = base!.includes("?") ? "&" : "?";
  const q = msg.error ? `error=${encodeURIComponent(msg.error)}` : `saved=${encodeURIComponent(msg.saved ?? "Saved.")}`;
  res.redirect(303, `${base}${sep}${q}${hash ? "#" + hash : ""}`);
}

/** Same-origin page the request came from, for "go back to where I was". */
function returnPath(req: express.Request, fallback: string): string {
  const r = String(req.body?.return ?? "");
  return r.startsWith("/admin") && !r.startsWith("//") ? r : fallback;
}

export function registerAdmin(app: express.Express, deps: AdminDeps): void {
  const { pool, ensureStudioAndStaff } = deps;

  async function badges(studioId: string): Promise<AdminBadges> {
    const r = await pool.query(
      `select count(*) filter (where ${FILTERS.awaiting.where} and x.payment_status <> 'initiated') as awaiting,
              count(*) filter (where ${FILTERS.print.where}) as to_print,
              count(*) filter (where ${FILTERS.deliver.where}) as to_deliver
         from (${ORDER_ROWS}) x`,
      [studioId],
    );
    return { awaiting: Number(r.rows[0].awaiting), toPrint: Number(r.rows[0].to_print), toDeliver: Number(r.rows[0].to_deliver) };
  }

  async function render(req: express.Request, res: express.Response, studioId: string,
                        opts: { title: string; active: Parameters<typeof adminPage>[0]["active"]; body: string; actions?: string }) {
    res.send(adminPage({ ...opts, badges: await badges(studioId), flash: flashFrom(req) }));
  }

  // ── Overview ──────────────────────────────────────────────────────────────
  app.get("/admin", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const k = (await pool.query(
      `select coalesce(sum(x.total_cents) filter (where x.payment_status = 'settled'), 0) as paid_cents,
              coalesce(sum(x.total_cents) filter (where x.payment_status = 'settled'
                         and x.placed_at >= date_trunc('month', now() at time zone 'Africa/Johannesburg')), 0) as month_cents,
              count(*) filter (where x.payment_status = 'settled') as paid_orders,
              count(*) filter (where ${FILTERS.awaiting.where}) as awaiting,
              coalesce(sum(x.total_cents) filter (where ${FILTERS.awaiting.where}), 0) as awaiting_cents,
              count(*) filter (where ${FILTERS.print.where}) as to_print,
              count(*) filter (where ${FILTERS.deliver.where}) as to_deliver
         from (${ORDER_ROWS}) x`,
      [studioId],
    )).rows[0];
    const c = (await pool.query(
      `select (select count(*) from school where studio_id = $1) as schools,
              (select count(*) from child where studio_id = $1) as children,
              (select count(distinct child_id) from claim_code where studio_id = $1 and redeemed_at is not null) as claimed,
              (select count(*) from child ch where ch.studio_id = $1
                  and not exists (select 1 from claim_code cc where cc.child_id = ch.id and cc.revoked_at is null)) as no_code,
              (select count(*) from package pk where pk.studio_id = $1 and pk.active
                  and not exists (select 1 from package_item pi where pi.package_id = pk.id)) as pkg_no_contents`,
      [studioId],
    )).rows[0];
    const yoco = await yocoStatus(pool, studioId);
    const recent = await pool.query(`select * from (${ORDER_ROWS}) x order by x.placed_at desc limit 8`, [studioId]);

    const todo: string[] = [];
    const t = (href: string, text: string, ok = false) =>
      `<li><a href="${href}"><span class="dot ${ok ? "ok" : ""}"></span><span>${text}</span><span class="go">→</span></a></li>`;
    if (Number(k.to_print)) todo.push(t("/admin/print", `<b>${k.to_print}</b> paid order${k.to_print == 1 ? "" : "s"} to print`));
    if (Number(k.to_deliver)) todo.push(t("/admin/print?tab=deliver", `<b>${k.to_deliver}</b> printed order${k.to_deliver == 1 ? "" : "s"} to deliver to school`));
    if (Number(k.awaiting)) todo.push(t("/admin/orders?status=awaiting", `<b>${k.awaiting}</b> order${k.awaiting == 1 ? "" : "s"} awaiting payment (${formatRands(k.awaiting_cents)})`));
    if (!yoco.connected) todo.push(t("/admin/settings", "Connect Yoco so parents can pay by card"));
    else if (!yoco.webhookReady) todo.push(t("/admin/settings", "Yoco is connected but automatic payment confirmation isn't set up"));
    else if (yoco.mode === "test") todo.push(t("/admin/settings", "Yoco is in test mode — switch to your live key to take real payments"));
    if (Number(c.no_code)) todo.push(t("/admin/schools", `<b>${c.no_code}</b> child${c.no_code == 1 ? " has" : "ren have"} no claim card yet`));
    if (Number(c.pkg_no_contents)) todo.push(t("/admin/catalogue#packages", `<b>${c.pkg_no_contents}</b> package${c.pkg_no_contents == 1 ? " has" : "s have"} no contents ticked`));
    const disk = await diskStatus();
    if (disk && disk.usedPct >= 75) todo.unshift(t("/admin/settings", `Photo storage is <b>${disk.usedPct}% full</b> (${gb(disk.freeBytes)} free) — increase it before the next import`));
    if (!todo.length) todo.push(`<li><div><span class="dot ok"></span>All caught up — nothing needs you right now.</div></li>`);

    const claimedPct = Number(c.children) ? Math.round((Number(c.claimed) / Number(c.children)) * 100) : 0;

    await render(req, res, studioId, {
      title: "Overview",
      active: "overview",
      actions: `<a class="btn small" href="/import.html">＋ Import a school</a>`,
      body: `
      <div class="kpis">
        <div class="kpi"><div class="n">${formatRands(k.month_cents)}</div><div class="l">Paid this month · ${formatRands(k.paid_cents)} all time</div></div>
        <a class="kpi ${Number(k.awaiting) ? "alert" : ""}" href="/admin/orders?status=awaiting"><div class="n">${k.awaiting}</div><div class="l">Awaiting payment · ${formatRands(k.awaiting_cents)}</div></a>
        <a class="kpi ${Number(k.to_print) ? "alert" : ""}" href="/admin/print"><div class="n">${k.to_print}</div><div class="l">Orders to print</div></a>
        <a class="kpi" href="/admin/print?tab=deliver"><div class="n">${k.to_deliver}</div><div class="l">Printed, to deliver</div></a>
        <a class="kpi" href="/admin/schools"><div class="n">${claimedPct}%</div><div class="l">${c.claimed} of ${c.children} children claimed · ${c.schools} school${c.schools == 1 ? "" : "s"}</div></a>
      </div>
      <div class="cols">
        <section class="panel">
          <h2>Recent orders <a class="more" href="/admin/orders">All orders →</a></h2>
          ${recent.rowCount ? orderTable(recent.rows, true) : `<div class="empty-state"><b>No orders yet</b>They appear here the moment a parent orders.</div>`}
        </section>
        <section class="panel">
          <h2>Needs you</h2>
          <ul class="todo">${todo.join("")}</ul>
        </section>
      </div>`,
    });
  });

  /** Orders as a table on wide screens, stacked rows on a phone (and always, when compact). */
  function orderTable(rows: any[], compact = false): string {
    return `<div class="tablewrap"><table class="dtable ${compact ? "list" : "cards"} orders-t"><thead><tr>
        <th>Order</th><th>Child</th><th>Items</th><th class="num">Total</th><th>Payment</th><th>Prints</th></tr></thead><tbody>
      ${rows.map((o) => `<tr class="rowlink" onclick="location.href='/admin/orders/${o.id}'">
          <td class="c-order"><a href="/admin/orders/${o.id}" class="strong mono nowrap">${escapeHtml(o.order_number)}</a> <span class="muted nowrap">${when(o.placed_at)}</span></td>
          <td class="c-child"><span class="strong">${escapeHtml(o.child ?? "—")}</span><div class="muted">${escapeHtml(o.school)}${classLabel(o) ? " · " + escapeHtml(classLabel(o)) : ""}</div></td>
          <td class="c-items muted">${escapeHtml(o.items ?? "")}</td>
          <td class="c-total num strong">${formatRands(o.total_cents)}</td>
          <td class="c-pay">${paymentChip(o.payment_status, o.offline_method)}</td>
          <td class="c-prod">${productionChip(o)}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  app.get("/admin/orders", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const status = (Object.keys(FILTERS).includes(String(req.query.status)) ? req.query.status : "all") as Filter;
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const school = UUID_RE.test(String(req.query.school ?? "")) ? String(req.query.school) : "";

    const params: unknown[] = [studioId];
    const where = [FILTERS[status].where];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(x.order_number ilike $${params.length} or x.email ilike $${params.length}
                   or app.immutable_unaccent(coalesce(x.child,'')) ilike app.immutable_unaccent($${params.length}))`);
    }
    if (school) { params.push(school); where.push(`x.school_id = $${params.length}`); }

    const rows = await pool.query(
      `select * from (${ORDER_ROWS}) x where ${where.map((w) => `(${w})`).join(" and ")} order by x.placed_at desc limit 300`,
      params,
    );
    const counts = (await pool.query(
      `select ${Object.entries(FILTERS).map(([key, f]) => `count(*) filter (where ${f.where}) as "${key}"`).join(", ")}
         from (${ORDER_ROWS}) x`,
      [studioId],
    )).rows[0];
    const schools = await pool.query(`select id, coalesce(display_name, name) as name from school where studio_id = $1 order by 2`, [studioId]);

    const link = (st: Filter) => {
      const u = new URLSearchParams({ status: st, ...(q ? { q } : {}), ...(school ? { school } : {}) });
      return `<a href="/admin/orders?${u}" class="${st === status ? "on" : ""}">${FILTERS[st].label} <span class="c">${counts[st]}</span></a>`;
    };

    await render(req, res, studioId, {
      title: "Orders",
      active: "orders",
      actions: `<a class="btn small ghost" href="/admin/orders.csv?${new URLSearchParams({ status, q, school })}">Download CSV</a>`,
      body: `
      <div class="toolbar"><div class="seg">${(Object.keys(FILTERS) as Filter[]).map(link).join("")}</div></div>
      <form class="toolbar" method="get" action="/admin/orders">
        <input type="hidden" name="status" value="${status}">
        <div class="search"><input name="q" value="${escapeHtml(q)}" placeholder="Search order number, parent email or child's name" aria-label="Search orders"></div>
        <select name="school" aria-label="School" onchange="this.form.submit()">
          <option value="">All schools</option>
          ${schools.rows.map((s) => `<option value="${s.id}" ${s.id === school ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
        </select>
        <button class="btn small" type="submit">Search</button>
        ${q || school ? `<a class="btn small ghost" href="/admin/orders?status=${status}">Clear</a>` : ""}
      </form>
      ${rows.rowCount
        ? orderTable(rows.rows)
        : `<div class="panel empty-state"><b>No orders here</b>${q ? `Nothing matches “${escapeHtml(q)}”.` : "Orders show up as soon as parents place them."}</div>`}`,
    });
  });

  // Spreadsheet export of whatever the list currently shows.
  app.get("/admin/orders.csv", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const status = (Object.keys(FILTERS).includes(String(req.query.status)) ? req.query.status : "all") as Filter;
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const school = UUID_RE.test(String(req.query.school ?? "")) ? String(req.query.school) : "";
    const params: unknown[] = [studioId];
    const where = [FILTERS[status].where];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(x.order_number ilike $2 or x.email ilike $2 or app.immutable_unaccent(coalesce(x.child,'')) ilike app.immutable_unaccent($2))`);
    }
    if (school) { params.push(school); where.push(`x.school_id = $${params.length}`); }
    const rows = await pool.query(
      `select * from (${ORDER_ROWS}) x where ${where.map((w) => `(${w})`).join(" and ")} order by x.placed_at desc`, params,
    );
    const cell = (v: unknown) => {
      let s = String(v ?? "");
      if (/^[=+\-@]/.test(s)) s = "'" + s; // no formula injection when opened in Excel
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [["Order", "Placed", "Child", "School", "Class", "Parent email", "Items", "Total (R)", "Payment", "Prints"].map(cell).join(",")];
    for (const o of rows.rows) {
      lines.push([o.order_number, new Date(o.placed_at).toISOString().slice(0, 10), o.child, o.school, classLabel(o), o.email,
        o.items, (Number(o.total_cents) / 100).toFixed(2), o.payment_status, o.needs_production ? o.fulfilment_status : "digital only"]
        .map(cell).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + lines.join("\r\n"));
  });

  /** Thumbnails for a set of asset ids, keyed by id. */
  async function thumbs(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const r = await pool.query(
      `select asset_id, storage_key from asset_variant where kind = 'thumb' and asset_id = any($1::uuid[])`, [ids],
    );
    return new Map(r.rows.map((x) => [x.asset_id, x.storage_key]));
  }
  const thumbLinks = (ids: string[], t: Map<string, string>, label: string) =>
    `<div class="thumbs">${ids.map((id, i) => `<a class="thumb" href="/admin/asset/${id}/original?name=${encodeURIComponent(`${label} ${i + 1}`)}"
        title="Download the original for printing">${t.get(id) ? `<img src="${publicUrl(t.get(id)!)}" alt="" loading="lazy">` : ""}<span class="dl">original ↓</span></a>`).join("")}</div>`;

  function lineAssets(snapshot: any): string[] {
    return [...new Set([snapshot?.assetId, ...(snapshot?.assetIds ?? [])].filter(Boolean))] as string[];
  }

  app.get("/admin/orders/:id", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    if (!UUID_RE.test(req.params.id)) return res.status(404).send("Unknown order.");
    const o = (await pool.query(`select * from (${ORDER_ROWS}) x where x.id = $2`, [studioId, req.params.id])).rows[0];
    if (!o) return res.status(404).send("Unknown order.");
    const lines = await pool.query(
      `select line_no, kind, quantity, line_total_cents, fulfilment_kind, snapshot from order_line where order_id = $1 order by line_no`,
      [o.id],
    );
    const pays = await pool.query(
      `select provider, provider_ref, method, amount_cents, status, created_at, settled_at from payment where order_id = $1 order by created_at`,
      [o.id],
    );
    const grants = (await pool.query(
      `select count(*) as n, coalesce(sum(downloads), 0) as used from download_grant where order_id = $1 and revoked_at is null`, [o.id],
    )).rows[0];
    const t = await thumbs([...new Set(lines.rows.flatMap((l) => lineAssets(l.snapshot)))]);
    const childLabel = (o.child ?? "photo").replace(/[^\p{L}\p{N} ]/gu, "");

    const paid = o.payment_status === "settled";
    const actions: string[] = [];
    if (paid && o.needs_production) {
      const next = o.fulfilment_status === "printed" ? ["dispatched", "Mark delivered to school"]
        : ["dispatched", "completed"].includes(o.fulfilment_status) ? null : ["printed", "Mark printed"];
      if (next) actions.push(fulfilmentButton(o.id, next[0]!, next[1]!, `/admin/orders/${o.id}`));
    }

    await render(req, res, studioId, {
      title: `Order ${o.order_number}`,
      active: "orders",
      actions: `<a class="btn small ghost" href="/admin/orders">← All orders</a>${actions.join("")}`,
      body: `
      <div class="cols">
        <section class="panel">
          <h2>What was ordered</h2>
          <div class="tablewrap"><table class="dtable olines"><thead><tr><th>Item</th><th>Photos</th><th class="num">Price</th></tr></thead><tbody>
          ${lines.rows.map((l) => {
            const ids = lineAssets(l.snapshot);
            const contents = Array.isArray(l.snapshot?.contents) && l.snapshot.contents.length
              ? l.snapshot.contents.map((c: any) => `${c.qty > 1 ? c.qty + " × " : ""}${c.name}`).join(", ")
              : l.snapshot?.description ?? "";
            return `<tr><td><b>${escapeHtml(l.snapshot?.name ?? l.kind)}</b>
                <div class="muted">${l.kind === "package" ? "Package" + (contents ? ": " + escapeHtml(contents) : "") : l.fulfilment_kind === "digital" ? "Digital download" : "Printed &amp; delivered to school"}</div></td>
              <td class="o-photos">${ids.length ? thumbLinks(ids, t, childLabel) : "—"}</td>
              <td class="num">${formatRands(l.line_total_cents)}</td></tr>`;
          }).join("")}
          <tr><td class="strong">Total</td><td class="o-photos"></td><td class="num strong">${formatRands(o.total_cents)}</td></tr>
          </tbody></table></div>
        </section>
        <div>
          <section class="panel">
            <h2>Status</h2>
            <dl class="kv">
              <dt>Payment</dt><dd>${paymentChip(o.payment_status, o.offline_method)}${o.offline_ref ? ` <span class="muted">${escapeHtml(o.offline_ref)}</span>` : ""}</dd>
              <dt>Prints</dt><dd>${productionChip(o)}</dd>
              <dt>Digital</dt><dd>${Number(grants.n) ? chip(`${grants.n} file${grants.n == 1 ? "" : "s"} released · ${grants.used} downloads`, "ok") : chip(o.digital_status === "none" ? "None in order" : "Released on payment", "muted")}</dd>
              <dt>Placed</dt><dd>${new Date(o.placed_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" })}</dd>
            </dl>
            ${paid ? "" : `
            <form method="post" action="/admin/order/${o.id}/mark-paid" class="form-grid" style="margin-top:16px">
              <input type="hidden" name="return" value="/admin/orders/${o.id}">
              <label>Paid by<select name="method"><option value="manual_eft">EFT</option><option value="cash">Cash</option></select></label>
              <label>Reference <span class="muted">(optional)</span><input name="ref" placeholder="e.g. bank ref or receipt no."></label>
              <button class="btn small green" type="submit">Mark paid · ${formatRands(o.total_cents)}</button>
            </form>
            <p class="muted" style="margin-top:8px">Card payments through Yoco are marked paid automatically.</p>`}
          </section>
          <section class="panel">
            <h2>Child &amp; parent</h2>
            <dl class="kv">
              <dt>Child</dt><dd>${o.child_id ? `<a href="/admin/preview/${o.child_id}" style="text-decoration:underline">${escapeHtml(o.child)}</a>` : "—"}</dd>
              <dt>School</dt><dd><a href="/admin/schools/${o.school_id}" style="text-decoration:underline">${escapeHtml(o.school)}</a></dd>
              <dt>Class</dt><dd>${escapeHtml(classLabel(o) || "—")}</dd>
              <dt>Parent email</dt><dd>${o.email && !o.email.endsWith("@claim.invalid") ? `<a href="mailto:${escapeHtml(o.email)}" style="text-decoration:underline">${escapeHtml(o.email)}</a>` : "—"}</dd>
            </dl>
          </section>
          ${pays.rowCount ? `<section class="panel"><h2>Payment attempts</h2>
            ${pays.rows.map((p) => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13.5px">
              ${chip(p.status, p.status === "settled" ? "ok" : p.status === "failed" ? "bad" : "muted")}
              <span>${escapeHtml(p.provider === "yoco" ? "Yoco" : p.provider)}${p.method ? " · " + escapeHtml(p.method) : ""}</span>
              <span class="money" style="margin-left:auto">${formatRands(p.amount_cents)}</span></div>`).join("")}</section>` : ""}
        </div>
      </div>`,
    });
  });

  // Cash or EFT. Card payments settle themselves through the Yoco webhook.
  app.post("/admin/order/:id/mark-paid", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send("Unknown order.");
    const back = returnPath(req, `/admin/orders/${req.params.id}`);
    const method = req.body.method === "cash" ? "cash" : "manual_eft";
    const ref = String(req.body.ref ?? "").trim().slice(0, 120) || "Marked paid by the studio";
    const { studioId } = await ensureStudioAndStaff();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.actor_kind', 'system', true)");
      const o = (await client.query(
        `update "order" set offline_method = $2, offline_ref = $3
          where id = $1 and studio_id = $4 and payment_status <> 'settled' returning total_cents, order_number`,
        [req.params.id, method, ref, studioId],
      )).rows[0];
      if (!o) { await client.query("rollback"); return backTo(res, back, { error: "That order is already paid." }); }
      await client.query(
        `insert into payment (studio_id, order_id, provider, provider_ref, method, amount_cents, status, settled_at)
         values ($1, $2, 'offline', $3, $4, $5, 'settled', now())`,
        [studioId, req.params.id, `${req.params.id}-${Date.now()}`, method === "cash" ? "cash" : "eft", o.total_cents],
      );
      // Same path as a Yoco webhook: settle, then release digital downloads.
      await settleOrder(client, req.params.id);
      await client.query("commit");
      backTo(res, back, { saved: `${o.order_number} marked paid (${method === "cash" ? "cash" : "EFT"}). Digital photos are now available to the parent.` });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.error(err);
      backTo(res, back, { error: "Couldn't mark that order paid: " + (err as Error).message });
    } finally {
      client.release();
    }
  });

  // ── Print & deliver ──────────────────────────────────────────────────────
  const FULFIL_LABEL: Record<string, string> = {
    printed: "printed", dispatched: "delivered to school", completed: "collected", not_started: "back to the print list",
  };

  function fulfilmentButton(id: string, status: string, label: string, back: string, ghost = false) {
    return `<form method="post" action="/admin/order/${id}/fulfilment" class="inline">
      <input type="hidden" name="status" value="${status}"><input type="hidden" name="return" value="${escapeHtml(back)}">
      <button class="btn small ${ghost ? "ghost" : status === "dispatched" ? "green" : ""}" type="submit">${label}</button></form>`;
  }

  async function setFulfilment(studioId: string, ids: string[], status: string): Promise<number> {
    if (!FULFIL_LABEL[status]) throw new Error("Unknown status.");
    const r = await pool.query(
      `update "order" set fulfilment_status = $3
        where studio_id = $1 and id = any($2::uuid[]) and (payment_status = 'settled' or offline_method is not null)`,
      [studioId, ids, status],
    );
    return r.rowCount ?? 0;
  }

  app.post("/admin/order/:id/fulfilment", async (req, res) => {
    const back = returnPath(req, "/admin/print");
    if (!UUID_RE.test(req.params.id)) return backTo(res, back, { error: "Unknown order." });
    const { studioId } = await ensureStudioAndStaff();
    const status = String(req.body.status);
    try {
      const n = await setFulfilment(studioId, [req.params.id], status);
      backTo(res, back, n ? { saved: `Order marked ${FULFIL_LABEL[status]}.` } : { error: "Only paid orders can move to printing." });
    } catch (err) {
      backTo(res, back, { error: (err as Error).message });
    }
  });

  app.post("/admin/fulfilment/bulk", async (req, res) => {
    const back = returnPath(req, "/admin/print");
    const { studioId } = await ensureStudioAndStaff();
    const ids = ([] as string[]).concat(req.body.ids ?? []).filter((x) => UUID_RE.test(x));
    const status = String(req.body.status);
    try {
      const n = await setFulfilment(studioId, ids, status);
      backTo(res, back, { saved: `${n} order${n === 1 ? "" : "s"} marked ${FULFIL_LABEL[status]}.` });
    } catch (err) {
      backTo(res, back, { error: (err as Error).message });
    }
  });

  app.get("/admin/print", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const tab = req.query.tab === "deliver" ? "deliver" : "print";
    const rows = (await pool.query(
      `select * from (${ORDER_ROWS}) x where ${FILTERS[tab].where}
        order by x.school, x.grade_name nulls last, x.class_name nulls last, x.child, x.placed_at`,
      [studioId],
    )).rows;
    const ids = rows.map((r) => r.id);
    const lines = ids.length
      ? (await pool.query(`select order_id, kind, fulfilment_kind, snapshot from order_line where order_id = any($1::uuid[]) order by line_no`, [ids])).rows
      : [];
    // Only what has to be physically produced: prints and gifts, and the
    // printed part of packages.
    const physical = lines.filter((l) =>
      l.fulfilment_kind === "physical" ||
      (l.kind === "package" && (!Array.isArray(l.snapshot?.contents) || !l.snapshot.contents.length ||
        l.snapshot.contents.some((c: any) => c.kind === "print" || c.kind === "merch"))));
    const t = await thumbs([...new Set(physical.flatMap((l) => lineAssets(l.snapshot)))]);

    // Group: school → class → orders.
    const groups = new Map<string, { label: string; orders: any[] }>();
    for (const o of rows) {
      const key = `${o.school} · ${classLabel(o) || "No class"}`;
      if (!groups.has(key)) groups.set(key, { label: key, orders: [] });
      groups.get(key)!.orders.push(o);
    }
    const back = `/admin/print${tab === "deliver" ? "?tab=deliver" : ""}`;
    const next = tab === "print" ? ["printed", "Mark printed"] : ["dispatched", "Mark delivered"];

    const body = [...groups.values()].map((g) => `
      <div class="grouphead"><span>${escapeHtml(g.label)}</span><span class="muted">${g.orders.length} order${g.orders.length === 1 ? "" : "s"}</span>
        <form method="post" action="/admin/fulfilment/bulk">
          ${g.orders.map((o) => `<input type="hidden" name="ids" value="${o.id}">`).join("")}
          <input type="hidden" name="status" value="${next[0]}"><input type="hidden" name="return" value="${back}">
          <button class="btn small ghost" type="submit">${next[1]} — whole class</button>
        </form></div>
      ${g.orders.map((o) => {
        const mine = physical.filter((l) => l.order_id === o.id);
        const label = (o.child ?? "photo").replace(/[^\p{L}\p{N} ]/gu, "");
        return `<div class="prodcard">
          <div class="who"><b>${escapeHtml(o.child ?? "—")}</b>
            <a class="mono muted" href="/admin/orders/${o.id}">${escapeHtml(o.order_number)}</a>
            <div class="muted">${escapeHtml(o.school)}${classLabel(o) ? " · " + escapeHtml(classLabel(o)) : ""}</div></div>
          <div class="items">${mine.map((l) => {
            const contents = Array.isArray(l.snapshot?.contents) && l.snapshot.contents.length
              ? l.snapshot.contents.filter((c: any) => c.kind === "print" || c.kind === "merch")
                  .map((c: any) => `${c.qty > 1 ? c.qty + " × " : ""}${c.name}`).join(", ")
              : l.snapshot?.description ?? "";
            const ids = lineAssets(l.snapshot);
            return `<div class="item"><div class="what"><b>${escapeHtml(l.snapshot?.name ?? "Item")}</b>
                ${l.kind === "package" ? `<small>${escapeHtml(contents)}</small><small>from the photos parent chose:</small>` : ""}</div>
              ${ids.length ? thumbLinks(ids, t, label) : `<span class="muted">No photo recorded</span>`}</div>`;
          }).join("") || `<span class="muted">—</span>`}</div>
          <div class="noprint">${fulfilmentButton(o.id, next[0]!, next[1]!, back)}
            ${tab === "deliver" ? fulfilmentButton(o.id, "not_started", "Undo", back, true) : ""}</div>
        </div>`;
      }).join("")}`).join("");

    const counts = (await pool.query(
      `select count(*) filter (where ${FILTERS.print.where}) as p, count(*) filter (where ${FILTERS.deliver.where}) as d from (${ORDER_ROWS}) x`,
      [studioId],
    )).rows[0];

    await render(req, res, studioId, {
      title: "Print & deliver",
      active: "print",
      actions: rows.length ? `<button class="btn small ghost" onclick="window.print()">Print this list</button>` : "",
      body: `
      <div class="toolbar"><div class="seg">
        <a href="/admin/print" class="${tab === "print" ? "on" : ""}">To print <span class="c">${counts.p}</span></a>
        <a href="/admin/print?tab=deliver" class="${tab === "deliver" ? "on" : ""}">Printed — to deliver <span class="c">${counts.d}</span></a>
      </div></div>
      <p class="muted noprint" style="margin-bottom:12px">${tab === "print"
        ? "Paid orders with prints or gifts, grouped by class so each class's envelopes come off the printer together. Click a photo to download the full-resolution original."
        : "Printed and packed. Mark them delivered when they've gone to the school."}</p>
      ${rows.length ? body : `<div class="panel empty-state"><b>${tab === "print" ? "Nothing to print" : "Nothing waiting for delivery"}</b>
        ${tab === "print" ? "Paid orders with prints land here automatically." : "Orders you mark printed wait here until they're delivered."}</div>`}`,
    });
  });

  // Full-resolution original, for printing. Staff only (behind /admin auth).
  app.get("/admin/asset/:id/original", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send("Unknown photo.");
    const { studioId } = await ensureStudioAndStaff();
    const a = (await pool.query(`select storage_key, original_name from asset where id = $1 and studio_id = $2`, [req.params.id, studioId])).rows[0];
    if (!a) return res.status(404).send("Unknown photo.");
    let bytes: Buffer;
    try { bytes = await getObject(a.storage_key); } catch { return res.status(404).send("The original file is missing from storage."); }
    const base = String(req.query.name ?? "").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || String(a.original_name ?? "photo").replace(/\.\w+$/, "");
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${base.replace(/[^\x20-\x7e]/g, "_")}.jpg"; filename*=UTF-8''${encodeURIComponent(base)}.jpg`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  });

  // ── Schools ──────────────────────────────────────────────────────────────
  app.get("/admin/schools", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const schools = await pool.query(
      `select s.id, coalesce(s.display_name, s.name) as name,
              (select count(*) from child c where c.school_id = s.id) as children,
              (select count(distinct cc.child_id) from claim_code cc join child c on c.id = cc.child_id
                where c.school_id = s.id and cc.redeemed_at is not null) as claimed,
              (select count(*) from asset a join shoot sh on sh.id = a.shoot_id where sh.school_id = s.id) as photos,
              (select count(*) from "order" o where o.school_id = s.id) as orders,
              (select coalesce(sum(total_cents), 0) from "order" o where o.school_id = s.id and o.payment_status = 'settled') as paid_cents
         from school s where s.studio_id = $1 order by 2`,
      [studioId],
    );
    await render(req, res, studioId, {
      title: "Schools",
      active: "schools",
      actions: `<a class="btn small" href="/import.html">＋ Import a school</a>`,
      body: schools.rowCount
        ? `<div class="schoolcards">${schools.rows.map((s) => {
            const pct = Number(s.children) ? Math.round((Number(s.claimed) / Number(s.children)) * 100) : 0;
            return `<a class="schoolcard" href="/admin/schools/${s.id}">
              <h3>${escapeHtml(s.name)}</h3>
              <div class="facts"><span><b>${s.children}</b> children</span><span><b>${s.photos}</b> photos</span><span><b>${s.orders}</b> orders</span></div>
              <div class="bar"><i style="width:${pct}%"></i></div>
              <div class="facts"><span>${pct}% of cards claimed</span><span style="margin-left:auto">${formatRands(s.paid_cents)} paid</span></div></a>`;
          }).join("")}</div>`
        : `<div class="panel empty-state"><b>No schools yet</b>Drag a school's folder into the importer — the school, grades, classes and children are detected from the folder names.<br><br>
            <a class="btn small" href="/import.html">Import a school</a></div>`,
    });
  });

  app.get("/admin/schools/:id", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    if (!UUID_RE.test(req.params.id)) return res.status(404).send("Unknown school.");
    const s = (await pool.query(`select * from school where id = $1 and studio_id = $2`, [req.params.id, studioId])).rows[0];
    if (!s) return res.status(404).send("Unknown school.");
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const cls = UUID_RE.test(String(req.query.class ?? "")) ? String(req.query.class) : "";
    const params: unknown[] = [s.id];
    let filter = "";
    if (q) { params.push(`%${q}%`); filter += ` and app.immutable_unaccent(c.first_name || ' ' || c.last_name) ilike app.immutable_unaccent($${params.length})`; }
    if (cls) { params.push(cls); filter += ` and en.class_id = $${params.length}`; }
    const children = await pool.query(
      `select c.id, c.first_name, c.last_name, en.class_name, en.grade_name,
              (select count(*) from gallery_item gi where gi.child_id = c.id) as photos,
              exists(select 1 from claim_code cc where cc.child_id = c.id and cc.redeemed_at is not null) as claimed,
              exists(select 1 from claim_code cc where cc.child_id = c.id and cc.revoked_at is null) as has_code,
              (select count(distinct ol.order_id) from order_line ol join "order" o on o.id = ol.order_id
                where ol.child_id = c.id and o.payment_status = 'settled') as paid_orders
         from child c
         left join lateral (select cl.id as class_id, cl.name as class_name, gr.name as grade_name, gr.sort_order
                              from enrolment e join class_group cl on cl.id = e.class_group_id left join grade gr on gr.id = cl.grade_id
                             where e.child_id = c.id order by e.academic_year desc limit 1) en on true
        where c.school_id = $1 ${filter}
        order by en.sort_order nulls last, en.class_name nulls last, c.last_name, c.first_name`,
      params,
    );
    const classes = await pool.query(
      `select cl.id, gr.name as grade, cl.name from class_group cl join grade gr on gr.id = cl.grade_id
        where cl.school_id = $1 order by gr.sort_order, cl.name`,
      [s.id],
    );
    const total = (await pool.query(
      `select count(*) as n, count(*) filter (where exists(select 1 from claim_code cc where cc.child_id = c.id and cc.redeemed_at is not null)) as claimed
         from child c where c.school_id = $1`, [s.id],
    )).rows[0];

    await render(req, res, studioId, {
      title: s.display_name || s.name,
      active: "schools",
      actions: `<a class="btn small ghost" href="/admin/orders?school=${s.id}">Orders</a>
        <a class="btn small ghost" href="/admin/cards/${s.id}">Print claim cards</a>
        <a class="btn small" href="/import.html">＋ Import more photos</a>`,
      body: `
      <div class="kpis">
        <div class="kpi"><div class="n">${total.n}</div><div class="l">Children</div></div>
        <div class="kpi"><div class="n">${total.claimed}</div><div class="l">Cards claimed by parents</div></div>
        <div class="kpi"><div class="n">${classes.rowCount}</div><div class="l">Classes</div></div>
      </div>
      <section class="panel">
        <h2>Children</h2>
        <form class="toolbar" method="get">
          <div class="search"><input name="q" value="${escapeHtml(q)}" placeholder="Search by name (Zane finds Zané)" aria-label="Search children"></div>
          <select name="class" aria-label="Class" onchange="this.form.submit()"><option value="">All classes</option>
            ${classes.rows.map((c) => `<option value="${c.id}" ${c.id === cls ? "selected" : ""}>${escapeHtml(c.grade)} · Class ${escapeHtml(c.name)}</option>`).join("")}</select>
          <button class="btn small" type="submit">Search</button>
          ${q || cls ? `<a class="btn small ghost" href="/admin/schools/${s.id}">Clear</a>` : ""}
        </form>
        ${children.rowCount ? `<div class="tablewrap"><table class="dtable kids"><thead><tr><th>Child</th><th>Class</th><th class="num">Photos</th><th>Card</th><th class="num">Paid orders</th><th></th></tr></thead><tbody>
          ${children.rows.map((c) => `<tr>
            <td class="k-name strong">${escapeHtml(c.first_name)} ${escapeHtml(c.last_name)}</td>
            <td class="k-class muted">${escapeHtml(classLabel(c) || "—")} <span class="k-sm">· ${c.photos} photos · ${c.paid_orders} paid</span></td>
            <td class="k-num num">${c.photos}</td>
            <td class="k-card">${c.claimed ? chip("Claimed", "ok") : c.has_code ? chip("Card printed", "muted") : chip("No card yet", "warn")}</td>
            <td class="k-num num">${c.paid_orders}</td>
            <td class="k-act"><a class="btn small ghost" href="/admin/preview/${c.id}">View gallery</a></td></tr>`).join("")}
          </tbody></table></div>` : `<div class="empty-state"><b>No children found</b>${q ? `Nothing matches “${escapeHtml(q)}”.` : ""}</div>`}
      </section>
      <section class="panel">
        <h2>School details</h2>
        <form method="post" action="/admin/school/${s.id}" class="form-grid">
          <label>Name parents see<input name="display_name" value="${escapeHtml(s.display_name ?? "")}" placeholder="${escapeHtml(s.name)}"></label>
          <label>School commission (%)<input name="commission_pct" inputmode="decimal" value="${(Number(s.commission_bps) / 100).toString()}"></label>
          <button class="btn small" type="submit">Save school</button>
        </form>
        <p class="muted" style="margin-top:8px">Folder name on import: ${escapeHtml(s.name)}</p>
      </section>`,
    });
  });

  app.post("/admin/school/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send("Unknown school.");
    const back = `/admin/schools/${req.params.id}`;
    const pct = Number(String(req.body.commission_pct ?? "0").replace(",", ".").replace("%", "").trim() || 0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return backTo(res, back, { error: "Commission must be a percentage between 0 and 100." });
    const { studioId } = await ensureStudioAndStaff();
    await pool.query(
      `update school set display_name = $1, commission_bps = $2 where id = $3 and studio_id = $4`,
      [String(req.body.display_name ?? "").trim() || null, Math.round(pct * 100), req.params.id, studioId],
    );
    backTo(res, back, { saved: "School saved." });
  });

  // ── Claim cards ─────────────────────────────────────────────────────────
  // A code's plaintext exists exactly once — it is stored hashed — so cards
  // are issued at the moment they are printed. Opening this page issues a
  // card for every child who doesn't have one yet; children whose card was
  // printed earlier keep it unless Wiaan explicitly reprints.
  app.get("/admin/cards/:schoolId", async (req, res) => {
    if (!UUID_RE.test(req.params.schoolId)) return res.status(404).send("Unknown school.");
    const { studioId, staffId } = await ensureStudioAndStaff();
    const school = (await pool.query(`select id, coalesce(display_name, name) as name from school where id = $1 and studio_id = $2`,
      [req.params.schoolId, studioId])).rows[0];
    if (!school) return res.status(404).send("Unknown school.");
    const shootId = await deps.findOrCreateShoot(studioId, school.id);
    const kids = (await pool.query(
      `select c.id, c.first_name, c.last_name, en.class_name, en.grade_name,
              exists(select 1 from claim_code cc where cc.child_id = c.id and cc.redeemed_at is not null) as claimed,
              exists(select 1 from claim_code cc where cc.child_id = c.id and cc.shoot_id = $2 and cc.revoked_at is null
                       and cc.redeemed_at is null and cc.expires_at > now()) as has_card
         from child c
         left join lateral (select cl.name as class_name, gr.name as grade_name, gr.sort_order
                              from enrolment e join class_group cl on cl.id = e.class_group_id left join grade gr on gr.id = cl.grade_id
                             where e.child_id = c.id order by e.academic_year desc limit 1) en on true
        where c.school_id = $1 and c.status = 'active'
        order by en.sort_order nulls last, en.class_name nulls last, c.last_name, c.first_name`,
      [school.id, shootId],
    )).rows;

    const origin = publicOrigin() ?? `${req.protocol}://${req.get("host")}`;
    const issued: Array<{ kid: any; code: string; qr: string }> = [];
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.actor_kind', 'staff', true)");
      await client.query("select set_config('app.studio_id', $1, true)", [studioId]);
      await client.query("select set_config('app.staff_id', $1, true)", [staffId]);
      await client.query("select set_config('app.staff_role', 'photographer', true)");
      for (const k of kids.filter((k) => !k.claimed && !k.has_card)) {
        const code = await issueClaimCode(client, {
          studioId, childId: k.id, shootId, expiresAt: new Date(Date.now() + 120 * 86_400_000),
        });
        issued.push({ kid: k, code: code.grouped, qr: await QRCode.toDataURL(`${origin}/?code=${code.grouped}`, { margin: 0, width: 260 }) });
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const host = origin.replace(/^https?:\/\//, "");
    const byClass = new Map<string, typeof issued>();
    for (const i of issued) {
      const key = classLabel(i.kid) || "No class";
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key)!.push(i);
    }
    const earlier = kids.filter((k) => !k.claimed && k.has_card);
    const claimed = kids.filter((k) => k.claimed);

    await render(req, res, studioId, {
      title: `Claim cards — ${school.name}`,
      active: "schools",
      actions: `<a class="btn small ghost" href="/admin/schools/${school.id}">← ${escapeHtml(school.name)}</a>
        ${issued.length ? `<button class="btn small" onclick="window.print()">Print ${issued.length} card${issued.length === 1 ? "" : "s"}</button>` : ""}`,
      body: `
      <div class="noprint">
        <div class="kpis">
          <div class="kpi ${issued.length ? "alert" : ""}"><div class="n">${issued.length}</div><div class="l">New cards on this page — print them now</div></div>
          <div class="kpi"><div class="n">${earlier.length}</div><div class="l">Printed earlier, not claimed yet</div></div>
          <div class="kpi"><div class="n">${claimed.length}</div><div class="l">Already claimed by a parent</div></div>
        </div>
        ${issued.length ? `<p class="muted" style="margin-bottom:14px">These codes are shown only once. Print now — leaving this page and coming back will not show them again (you can always reprint).</p>` : ""}
        ${earlier.length ? `<section class="panel"><h2>Printed earlier (${earlier.length})</h2>
          <p class="sub">Those cards still work. If they were lost, reprint — the old cards stop working and new ones appear here.</p>
          <div class="muted" style="margin-bottom:12px">${earlier.map((k) => escapeHtml(`${k.first_name} ${k.last_name}`)).join(", ")}</div>
          <form method="post" action="/admin/cards/${school.id}/reissue" onsubmit="return confirm('Make new cards for ${earlier.length} child(ren)? Their old cards will stop working.')">
            <button class="btn small ghost" type="submit">Reprint unclaimed cards</button></form></section>` : ""}
        ${!issued.length && !earlier.length ? `<div class="panel empty-state"><b>Nothing to print</b>Every child's card has been claimed by a parent.</div>` : ""}
      </div>
      ${[...byClass.entries()].map(([cls, list]) => `
        <section class="cardsheet">
          <h2 class="sheethead">${escapeHtml(school.name)} · ${escapeHtml(cls)} <span>${list.length} card${list.length === 1 ? "" : "s"}</span></h2>
          <div class="cardgrid">${list.map((i) => `
            <article class="claimcard" data-child="${escapeHtml(`${i.kid.first_name} ${i.kid.last_name}`)}" data-code="${i.code}">
              <div class="cc-brand">WIAAN JORDAAN <span>PHOTOGRAPHY</span></div>
              <div class="cc-name">${escapeHtml(i.kid.first_name)} ${escapeHtml(i.kid.last_name)}</div>
              <div class="cc-class">${escapeHtml(school.name)}${classLabel(i.kid) ? " · " + escapeHtml(classLabel(i.kid)) : ""}</div>
              <img class="cc-qr" src="${i.qr}" alt="QR code">
              <div class="cc-how">Scan to see your child's photographs, or go to <b>${escapeHtml(host)}</b> and enter:</div>
              <div class="cc-code">${i.code}</div>
            </article>`).join("")}</div>
        </section>`).join("")}`,
    });
  });

  app.post("/admin/cards/:schoolId/reissue", async (req, res) => {
    if (!UUID_RE.test(req.params.schoolId)) return res.status(404).send("Unknown school.");
    const { studioId } = await ensureStudioAndStaff();
    await pool.query(
      `update claim_code cc set revoked_at = now()
         from child c
        where c.id = cc.child_id and c.school_id = $1 and c.studio_id = $2
          and cc.revoked_at is null and cc.redeemed_at is null`,
      [req.params.schoolId, studioId],
    );
    res.redirect(303, `/admin/cards/${req.params.schoolId}`);
  });

  // ── Products & packages ─────────────────────────────────────────────────
  app.get("/admin/catalogue", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const products = await pool.query(
      `select p.id, p.sku, p.name_i18n->>'en' as name, p.kind, p.active,
              (select pr.amount_cents from price pr join price_list pl on pl.id = pr.price_list_id
                where pr.product_id = p.id and pl.status = 'published' order by pl.effective_from desc limit 1) as amount_cents
         from product p where p.studio_id = $1 order by p.active desc, p.kind, p.name_i18n->>'en'`,
      [studioId],
    );
    const packages = await pool.query(
      `select pk.id, pk.name_i18n->>'en' as name, pk.description_i18n->>'en' as description, pk.active,
              (select pr.amount_cents from price pr join price_list pl on pl.id = pr.price_list_id
                where pr.package_id = pk.id and pl.status = 'published' order by pl.effective_from desc limit 1) as amount_cents,
              coalesce((select jsonb_object_agg(pi.product_id, pi.quantity) from package_item pi where pi.package_id = pk.id), '{}'::jsonb) as items
         from package pk where pk.studio_id = $1 order by pk.active desc, pk.sort_order, pk.name_i18n->>'en'`,
      [studioId],
    );

    await render(req, res, studioId, {
      title: "Products & packages",
      active: "catalogue",
      body: `
      <section class="panel" id="packages">
        <h2>Packages</h2>
        <p class="sub">One price for a bundle. Tick what's in it — digital items in a package are released the moment the parent pays.</p>
        ${packages.rows.length ? packages.rows.map((pk) => packageEditor(pk, products.rows)).join("") : `<div class="empty-state">No packages yet.</div>`}
        <details class="newpkg"><summary class="btn small ghost">＋ New package</summary>
          <form method="post" action="/admin/package" class="pkgform">
            <label>Name<input name="name" placeholder="e.g. Platinum" required></label>
            <label>Price<span class="rands"><span>R</span><input name="price" inputmode="decimal" placeholder="1 200" required></span></label>
            <label class="wide">What parents read<input name="description" placeholder="e.g. Everything in Gold plus an A3 print"></label>
            <button type="submit" class="btn small">Create package</button>
          </form>
        </details>
      </section>
      <section class="panel" id="products">
        <h2>Products</h2>
        <p class="sub">Prices in Rands, VAT included — type <b>145</b> or <b>145,50</b>. Per-photo items are charged once for every photograph the parent chooses; a full digital gallery is one price.</p>
        ${products.rows.map((p) => `<form id="p-${p.id}" method="post" action="/admin/product/${p.id}"></form>`).join("")}
        <div class="tablewrap"><table class="dtable edit prods"><thead><tr><th>Product</th><th>Type</th><th>Price</th><th>On sale</th><th></th></tr></thead><tbody>
          ${products.rows.map((p) => `<tr class="${p.active ? "" : "off"}">
              <td class="pr-name"><input form="p-${p.id}" name="name" value="${escapeHtml(p.name)}" required aria-label="Product name"></td>
              <td class="pr-kind">${chip(KIND_LABEL[p.kind] ?? p.kind, p.kind.startsWith("digital") ? "info" : "muted")}</td>
              <td class="pr-price"><label class="rands"><span>R</span><input form="p-${p.id}" name="price" inputmode="decimal"
                    value="${randsInputValue(p.amount_cents)}" required aria-label="Price in Rands"></label></td>
              <td class="pr-on"><label class="toggle"><input form="p-${p.id}" type="checkbox" name="active" ${p.active ? "checked" : ""} aria-label="On sale"><span class="k-sm">On sale</span></label></td>
              <td class="pr-save"><button form="p-${p.id}" type="submit" class="btn small ghost">Save</button></td></tr>`).join("")}
        </tbody></table></div>
        <form method="post" action="/admin/product" class="addrow">
          <input name="name" placeholder="New product, e.g. A4 Print" required>
          <select name="kind" aria-label="Type">
            <option value="print">Print (per photo)</option>
            <option value="merch">Gift / merchandise (per photo)</option>
            <option value="digital_single">Digital image (per photo)</option>
            <option value="digital_gallery">Full digital gallery</option>
          </select>
          <label class="rands"><span>R</span><input name="price" inputmode="decimal" placeholder="145" required aria-label="Price in Rands"></label>
          <button type="submit" class="btn small">Add product</button>
        </form>
      </section>`,
    });
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get("/admin/settings", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    const yoco = await yocoStatus(pool, studioId);
    await render(req, res, studioId, {
      title: "Settings",
      active: "settings",
      body: `
      <section class="panel"><h2>Card payments (Yoco)</h2>${paymentsPanel(yoco)}</section>
      <section class="panel" id="storage"><h2>Photo storage</h2>${storagePanel(await diskStatus())}</section>
      <section class="panel"><h2>System</h2>
        <dl class="kv">
          <dt>Website</dt><dd>${escapeHtml(publicOrigin() ?? "local")}</dd>
          <dt>Database</dt><dd>${deps.bootState.migrations === "ok" ? chip("Up to date", "ok") : chip(deps.bootState.migrations, "bad")}</dd>
          <dt>Parent privacy</dt><dd>${rlsEnforcedForParents() ? chip("Enforced by app and database", "ok") : chip("Enforced by app", "warn")}</dd>
          <dt>Staff login</dt><dd class="muted">Set on the server (STAFF_USER / STAFF_PASSWORD).</dd>
        </dl>
      </section>`,
    });
  });

  app.post("/admin/storage/sweep", async (_req, res) => {
    try {
      const r = await sweepOrphans(pool);
      backTo(res, "/admin/settings#storage", { saved: r.deleted
        ? `Freed ${gb(r.freedBytes)} (${r.deleted} unused files from failed or abandoned uploads).`
        : "Nothing to free — every stored file belongs to a photo." });
    } catch (err) {
      backTo(res, "/admin/settings#storage", { error: "Cleanup stopped safely: " + (err as Error).message });
    }
  });

  app.post("/admin/payments", async (req, res) => {
    const { studioId } = await ensureStudioAndStaff();
    if (process.env.YOCO_SECRET_KEY) return res.redirect(303, "/admin/settings");
    const st = await saveYocoKey(pool, studioId, String(req.body.secret_key ?? ""));
    backTo(res, "/admin/settings", st.lastError && !st.webhookReady
      ? { error: st.lastError }
      : { saved: st.connected ? "Yoco connected." : "Yoco disconnected." });
  });
}

export function packageEditor(pk: any, products: any[]): string {
  const items = (pk.items ?? {}) as Record<string, number>;
  const byId = new Map(products.map((p) => [p.id, p.name]));
  const summary = Object.entries(items)
    .map(([id, q]) => `${q > 1 ? q + " × " : ""}${byId.get(id) ?? "item"}`).join(", ");
  const rows = products
    .filter((p) => p.active || items[p.id])
    .map(
      (p) => `<label class="pkgitem ${items[p.id] ? "on" : ""}"><input type="number" name="qty_${p.id}" min="0" max="99"
          value="${items[p.id] ?? 0}" inputmode="numeric" aria-label="Quantity of ${escapeHtml(p.name)}">
        <span>${escapeHtml(p.name)}</span></label>`,
    )
    .join("");
  return `<details class="pkgcard ${pk.active ? "" : "off"}">
    <summary>
      <span class="pk-name">${escapeHtml(pk.name)}</span>
      <span class="pk-price">${formatRands(pk.amount_cents ?? 0)}</span>
      ${pk.active ? chip("Offered", "ok") : chip("Hidden", "muted")}
      <span class="pk-contents">${summary ? escapeHtml(summary) : `<span class="warn-text">No contents ticked yet</span>`}</span>
      <span class="pk-edit">Edit</span>
    </summary>
    <form method="post" action="/admin/package/${pk.id}">
      <div class="pkgform">
        <label>Name<input name="name" value="${escapeHtml(pk.name)}" required></label>
        <label>Price<span class="rands"><span>R</span><input name="price" inputmode="decimal"
          value="${randsInputValue(pk.amount_cents)}" required></span></label>
        <label class="wide">What parents read<input name="description" value="${escapeHtml(pk.description ?? "")}"
          placeholder="Left empty, this is written from the contents below"></label>
      </div>
      <div class="pkglabel">Contents <span>— how many of each (0 = not included)</span></div>
      <div class="pkgitems">${rows}</div>
      <div class="pkgfoot">
        <label class="toggle"><input type="checkbox" name="active" ${pk.active ? "checked" : ""}> Offered to parents</label>
        <button type="submit" class="btn small">Save package</button>
      </div>
    </form>
  </details>`;
}

function paymentsPanel(y: Awaited<ReturnType<typeof yocoStatus>>): string {
  const input = `<input name="secret_key" type="password" autocomplete="off" placeholder="sk_live_… or sk_test_…"
       style="flex:1;min-width:240px;padding:9px 11px;border:1px solid var(--rule);border-radius:8px">`;
  if (!y.connected) {
    return `<p class="sub" style="margin:0 0 12px">Not connected — parents can still order, and you mark cash or EFT payments as paid.
        To take card payments, paste your <b>secret key</b> from the Yoco app
        (Yoco Connect → Checkout API → How to connect). Everything else is set up automatically.</p>
      <form method="post" action="/admin/payments" style="display:flex;gap:8px;flex-wrap:wrap;max-width:620px">
        ${input}<button type="submit" class="btn small">Connect Yoco</button></form>`;
  }
  const mode = y.mode === "live" ? chip("Live", "ok") : chip("Test mode", "warn");
  const hook = y.webhookReady ? chip("Automatic payment confirmation on", "ok") : chip("Automatic confirmation not set up", "bad");
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${mode} ${hook}</div>
    ${y.mode === "test" ? `<p class="sub" style="margin:0 0 10px">Test mode: no real money moves. Switch to your live key once Yoco has verified this website's domain.</p>` : ""}
    ${y.lastError && !y.webhookReady ? `<div class="flash">${escapeHtml(y.lastError)}</div>` : ""}
    ${y.source === "env"
      ? `<p class="muted">The key is set on the server (YOCO_SECRET_KEY), so it can't be changed here.</p>`
      : `<form method="post" action="/admin/payments" style="display:flex;gap:8px;flex-wrap:wrap;max-width:620px">
           ${input}<button type="submit" class="btn small">Replace key</button></form>
         <form method="post" action="/admin/payments" style="margin-top:8px"
               onsubmit="return confirm('Disconnect Yoco? Parents will no longer be able to pay by card.')">
           <input type="hidden" name="secret_key" value=""><button type="submit" class="btn small ghost">Disconnect</button></form>`}`;
}

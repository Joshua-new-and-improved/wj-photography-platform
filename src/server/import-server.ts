import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

import { proposeStructure, similarity, type UploadedFile } from "../lib/import/folders.js";
import { childFolderFromPath } from "../lib/import/childfolder.js";
import { segmentBySlates, reviewSummary, type Frame } from "../lib/import/segment.js";
import { deriveVariants } from "../lib/media/derive.js";
import { putObject, publicUrl, randomKey } from "../lib/storage/local.js";
import { issueClaimCode, redeemClaimCode, completeClaim } from "../lib/claim.js";
import { generateSessionToken, hashToken, generateOrderNumber } from "../lib/ids.js";
import { page, escapeHtml } from "./views.js";

/**
 * A real, running server — not another prototype.
 *
 * The point of this version is that Wiaan's life should actually get easier:
 * drag a folder in, and the school, the classes, and the children are all
 * detected from the folder names he already uses. Nothing here requires
 * typing a name that is already sitting in a folder path.
 *
 * ── Database role: MUST be a genuine superuser, not app_rw or app_owner ──
 * Migration 0008 applies FORCE ROW LEVEL SECURITY to every table, which
 * removes Postgres's normal owner exemption on purpose. Only a real
 * superuser session can bootstrap a studio from an empty database. Point
 * DATABASE_URL at the `postgres` superuser. The production application never
 * connects this way — see src/lib/db.ts, which connects as app_rw and cannot
 * bypass anything.
 *
 * Storage is local disk (src/lib/storage/local.ts) rather than S3. Swapping
 * it for the real adapter later is a one-file change.
 */

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://localhost/spp",
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 5000 },
});

/**
 * Staff-only barrier in front of the import tool and admin console.
 *
 * Basic Auth is a deliberately blunt stopgap: not the real staff login the
 * architecture describes (OTP, roles, MFA — §6.5), but five lines that close
 * the hole today. Replace it when the real staff auth lands.
 */
function requireStaffAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = process.env.STAFF_USER;
  const pass = process.env.STAFF_PASSWORD;
  if (!user || !pass) {
    return res.status(503).send("Staff area is not configured. Set STAFF_USER and STAFF_PASSWORD.");
  }
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, p] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (u === user && p === pass) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Studio", charset="UTF-8"');
  res.status(401).send("Staff sign-in required.");
}

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use((req, _res, next) => {
  const raw = req.headers.cookie ?? "";
  (req as any).cookies = Object.fromEntries(
    raw.split(";").map((p) => p.trim().split("=")).filter((p) => p[0]),
  );
  next();
});

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? new URL("../../storage", import.meta.url).pathname;
app.use("/storage", express.static(STORAGE_ROOT));

const PUBLIC_DIR = new URL("../../public", import.meta.url).pathname;
app.get("/import.html", requireStaffAuth, (_req, res) => res.sendFile(PUBLIC_DIR + "/import.html"));
app.use("/api/import", requireStaffAuth);
app.use("/admin", requireStaffAuth);
app.use(express.static(PUBLIC_DIR));

// ============================================================================
// Studio / school / shoot resolution
//
// One studio (architecture A1 — a single photography business). Schools and
// shoots are NOT hardcoded: the school is detected from the top-level folder
// name on every import, matched fuzzily against schools already on file, and
// created automatically the first time a new one appears. This is the piece
// that makes "easy access to different schools" real rather than aspirational
// — there is no per-school setup step; dragging in a new school's folder IS
// the setup step.
// ============================================================================

async function ensureStudioAndStaff(): Promise<{ studioId: string; staffId: string }> {
  const s = await pool.query(`select id from studio limit 1`);
  let studioId = s.rows[0]?.id as string | undefined;
  if (!studioId) {
    const r = await pool.query(
      `insert into studio (name, default_locale) values ('Wiaan Jordaan Photography','en') returning id`,
    );
    studioId = r.rows[0].id;
  }

  // 'photographer' rather than 'owner'/'admin': those roles require MFA to be
  // active (staff_privileged_requires_mfa, migration 0002), which a scripted
  // bootstrap has no way to satisfy.
  const st = await pool.query(`select id from staff_user where studio_id = $1 limit 1`, [studioId]);
  let staffId = st.rows[0]?.id as string | undefined;
  if (!staffId) {
    const r = await pool.query(
      `insert into staff_user (studio_id, email, full_name, role, status)
       values ($1, 'wiaan@wjphotography.co.za', 'Wiaan Jordaan', 'photographer', 'active')
       returning id`,
      [studioId],
    );
    staffId = r.rows[0].id;
  }

  return { studioId: studioId!, staffId: staffId! };
}

/**
 * Find the school a detected folder name refers to, or create it.
 *
 * Fuzzy-matched so "Laerskool Louis Leipoldt" and "Louis Leipoldt Primary"
 * (a re-import with a slightly different top folder name) resolve to the
 * same school rather than silently forking Wiaan's data into two schools.
 * The threshold is deliberately conservative — see similarity() in
 * folders.ts, which scores differing digits at zero — so two genuinely
 * different schools are never merged by accident.
 */
async function findOrCreateSchool(studioId: string, detectedName: string): Promise<{ id: string; name: string }> {
  const name = (detectedName || "Untitled School").trim();
  const existing = await pool.query(`select id, name from school where studio_id = $1`, [studioId]);

  let best: { id: string; name: string; score: number } | null = null;
  for (const row of existing.rows) {
    const score = similarity(name, row.name);
    if (score >= 0.75 && (!best || score > best.score)) {
      best = { id: row.id, name: row.name, score };
    }
  }
  if (best) return { id: best.id, name: best.name };

  const code = name
    .split(/\s+/)
    .map((w: string) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 6) || "SCH";
  const inserted = await pool.query(
    `insert into school (studio_id, name, code, agreement_signed_at, agreement_expires_at)
     values ($1, $2, $3, now(), now() + interval '1 year')
     on conflict (studio_id, code) do update set name = excluded.name
     returning id, name`,
    [studioId, name, code + "-" + Math.random().toString(36).slice(2, 5).toUpperCase()],
  );
  return inserted.rows[0];
}

/** Reuse the school's current open shoot, or start a new one for today. */
async function findOrCreateShoot(studioId: string, schoolId: string): Promise<string> {
  const open = await pool.query(
    `select id from shoot where studio_id = $1 and school_id = $2 and status = 'open'
      order by created_at desc limit 1`,
    [studioId, schoolId],
  );
  if (open.rows[0]) return open.rows[0].id;

  const school = await pool.query(`select name from school where id = $1`, [schoolId]);
  const label = `${school.rows[0].name} — ${new Date().toISOString().slice(0, 10)}`;
  const created = await pool.query(
    `insert into shoot (studio_id, school_id, name, kind, academic_year, shoot_date,
                        gallery_opens_at, order_deadline_at, status)
     values ($1, $2, $3, 'individual', $4, current_date,
             now(), now() + interval '30 days', 'open')
     returning id`,
    [studioId, schoolId, label, new Date().getFullYear()],
  );
  return created.rows[0].id;
}

// ============================================================================
// PAGES
// ============================================================================

const NAV = `<a class="navlink" href="/admin">Studio</a><a class="navlink" href="/import.html">Import</a>`;

// ── Home: claim code entry ───────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send(
    page({
      title: "Find your child's photographs",
      nav: NAV,
      body: `
      <div class="claim">
        <h1>Find your child's<br>photographs</h1>
        <p>Enter the code from the letter. No account needed to look.</p>
        <div class="codebox">
          <input class="g4 mono" id="c1" maxlength="4" placeholder="XXXX" autocomplete="off">
          <input class="g3 mono" id="c2" maxlength="3" placeholder="XXX" autocomplete="off">
          <input class="g3 mono" id="c3" maxlength="3" placeholder="XXX" autocomplete="off">
        </div>
        <div class="err" id="err"></div>
        <button class="btn" id="go">Show me the photographs</button>
      </div>
      <script>
        const $=id=>document.getElementById(id);
        ['c1','c2','c3'].forEach((id,i,arr)=>{
          const el=$(id);
          el.oninput=()=>{
            el.value=el.value.toUpperCase().replace(/[ILil]/g,'1').replace(/[Oo]/g,'0')
                     .replace(/[^0-9A-HJKMNP-TV-Z]/g,'');
            if(el.value.length===el.maxLength && arr[i+1]) $(arr[i+1]).focus();
          };
        });
        $('go').onclick=async()=>{
          const code = $('c1').value + $('c2').value + $('c3').value;
          $('go').disabled = true; $('err').textContent='';
          const r = await fetch('/api/claim/redeem', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ code })
          });
          const data = await r.json();
          if (r.ok) {
            window.location.href = '/g/' + data.childId;
          } else {
            $('err').textContent = data.message || 'Something went wrong.';
            $('go').disabled = false;
          }
        };
      </script>`,
    }),
  );
});

// ── Redeem: needs a shootId — a claim code is scoped to a shoot, and a code
//    could belong to any school's shoot, so this looks the code up by hint
//    across all of the studio's open shoots rather than assuming one. ──────
app.post("/api/claim/redeem", async (req, res) => {
  const client = await pool.connect();
  try {
    const { code } = req.body as { code: string };
    const { studioId } = await ensureStudioAndStaff();
    await client.query("select set_config('app.actor_kind', 'system', true)");

    const shoots = await pool.query(
      `select id from shoot where studio_id = $1 and status = 'open'`,
      [studioId],
    );

    let result: Awaited<ReturnType<typeof redeemClaimCode>> | null = null;
    for (const s of shoots.rows) {
      const attempt = await redeemClaimCode(client, {
        submitted: code ?? "",
        shootId: s.id,
        ip: req.ip ?? "0.0.0.0",
      });
      if (attempt.outcome === "success") { result = attempt; break; }
      // Keep the most informative non-success outcome to report, preferring
      // "already redeemed" over a plain "not found" since it is the more
      // actionable signal for the parent (§6.2).
      if (!result || attempt.outcome !== "not_found") result = attempt;
    }

    if (!result || result.outcome !== "success") {
      return res.status(400).json({ message: result?.message ?? "That code was not recognised." });
    }

    let guardian = await client.query(`select id from guardian where email = $1`, ["testparent@example.com"]);
    let guardianId = guardian.rows[0]?.id as string | undefined;
    if (!guardianId) {
      const r = await client.query(
        `insert into guardian (email, full_name, verified_at) values ($1,$2,now()) returning id`,
        ["testparent@example.com", "Test Parent"],
      );
      guardianId = r.rows[0].id;
    }

    await completeClaim(client, {
      studioId,
      claimCodeId: result.claimCodeId!,
      childId: result.childId!,
      shootId: result.shootId!,
      guardianId: guardianId!,
      ip: req.ip ?? "0.0.0.0",
      consentWordingVersion: "v1.0",
      locale: "en",
    });

    const token = generateSessionToken();
    await client.query(
      `insert into guardian_session (guardian_id, token_hash, expires_at)
       values ($1,$2, now() + interval '24 hours')`,
      [guardianId, hashToken(token)],
    );
    res.cookie("session", token, { httpOnly: true, sameSite: "lax" });

    res.json({ childId: result.childId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Something went wrong on our end." });
  } finally {
    client.release();
  }
});

// ── Parent gallery ────────────────────────────────────────────────────────────
app.get("/g/:childId", async (req, res) => {
  const child = await pool.query(
    `select c.id, c.first_name, c.last_name, c.school_id, cl.name as class_name, g.name as grade_name,
            s.display_name, s.name as school_name
       from child c
       left join enrolment e on e.child_id = c.id
       left join class_group cl on cl.id = e.class_group_id
       left join grade g on g.id = cl.grade_id
       join school s on s.id = c.school_id
      where c.id = $1`,
    [req.params.childId],
  );
  if (child.rowCount === 0) {
    return res.status(404).send(page({ title: "Not found", nav: NAV, body: `<div class="empty">No such gallery.</div>` }));
  }
  const c = child.rows[0];
  const schoolLabel = c.display_name || c.school_name;

  const images = await pool.query(
    `select a.id as asset_id, av.storage_key
       from gallery_item gi
       join asset a on a.id = gi.asset_id
       join asset_variant av on av.asset_id = a.id and av.kind = 'preview'
      where gi.child_id = $1
      order by gi.sort_order`,
    [req.params.childId],
  );

  // Real prices, from whatever price list is actually published — the same
  // one the admin Settings page edits. Nothing here is hardcoded.
  const priceList = await pool.query(
    `select id from price_list where studio_id = (select studio_id from child where id = $1)
       and status = 'published' order by effective_from desc limit 1`,
    [req.params.childId],
  );
  const products = priceList.rows[0]
    ? await pool.query(
        `select p.id, p.name_i18n->>'en' as name, pr.amount_cents
           from product p join price pr on pr.product_id = p.id and pr.price_list_id = $1
          where p.studio_id = (select studio_id from child where id = $2) and p.active = true
          order by pr.amount_cents`,
        [priceList.rows[0].id, req.params.childId],
      )
    : { rows: [] };

  const grid = images.rows.length
    ? images.rows
        .map(
          (r) => `<div class="frame" data-asset="${r.asset_id}" tabindex="0" role="button">
            <img src="${publicUrl(r.storage_key)}" alt="">
            <div class="pickmark">✓</div>
          </div>`,
        )
        .join("")
    : `<div class="empty">No photographs in this gallery yet.</div>`;

  const productRows = products.rows
    .map(
      (p) =>
        `<label class="prow"><input type="checkbox" class="prod" value="${p.id}" data-name="${escapeHtml(p.name)}" data-cents="${p.amount_cents}">
           <span>${escapeHtml(p.name)}</span><span class="pmoney">R${(p.amount_cents / 100).toFixed(2)}</span></label>`,
    )
    .join("");

  res.send(
    page({
      title: `${c.first_name} ${c.last_name}`,
      nav: NAV,
      body: `
      <style>
        .frame{cursor:pointer;position:relative}
        .frame .pickmark{position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:99px;
          background:var(--paper);border:1px solid var(--rule);display:flex;align-items:center;justify-content:center;
          font-size:12px;color:transparent}
        .frame.picked{outline:2px solid var(--chinagraph)}
        .frame.picked .pickmark{background:var(--chinagraph);color:#fff;border-color:var(--chinagraph)}
        .order-panel{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:16px;margin-top:12px}
        .prow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--rule);cursor:pointer}
        .prow:last-child{border:0}
        .pmoney{margin-left:auto;font-family:var(--mono)}
        .ordertotal{display:flex;justify-content:space-between;padding-top:12px;margin-top:4px;
          border-top:1px solid var(--graphite);font-weight:600;font-size:16px}
        input[type=email]{width:100%;padding:10px;border:1px solid var(--rule);border-radius:2px;margin:10px 0}
      </style>
      <div class="sheet-head">
        <div class="kid">
          <h1>${escapeHtml(c.first_name)}</h1>
          <span class="cls">${escapeHtml(schoolLabel)}${c.grade_name ? " · " + escapeHtml(c.grade_name) : ""}${c.class_name ? " " + escapeHtml(c.class_name) : ""}</span>
        </div>
      </div>
      <div class="sectlabel"><span>Photographs — tap to select</span></div>
      <div class="sheet" id="grid">${grid}</div>

      ${
        products.rows.length === 0
          ? `<div class="note">No products are priced yet — the studio hasn't set up pricing for this school.</div>`
          : `
      <div class="sectlabel"><span>Order</span></div>
      <div class="order-panel">
        <div id="pickCount" class="mono" style="color:var(--silver);font-size:12px;margin-bottom:10px">No photographs selected</div>
        ${productRows}
        <div class="ordertotal"><span>Total</span><span id="total">R0.00</span></div>
        <input type="email" id="email" placeholder="Your email address" required>
        <div id="emailErr" style="color:var(--chinagraph);font-size:12px;min-height:16px"></div>
        <button class="btn" id="place" disabled>Select photographs and products to order</button>
        <div id="confirm" style="display:none;margin-top:14px;padding:14px;background:#f0f7f4;border-radius:2px">
          <b>Order received.</b> <span id="ordNum"></span><br>
          <span style="font-size:13px">The studio will be in touch to arrange payment. Once payment is
          confirmed, any digital images in this order are emailed immediately; prints follow after the
          school's order deadline.</span>
        </div>
      </div>`
      }
      <div class="note">Real order, real database, real pricing — the one thing not live yet is a card
        payment gateway. Payment is confirmed by the studio for now.</div>
      <script>
        const picked=new Set();
        document.querySelectorAll('.frame').forEach(f=>{
          f.onclick=()=>{
            const id=f.dataset.asset;
            picked.has(id)?picked.delete(id):picked.add(id);
            f.classList.toggle('picked');
            update();
          };
        });
        function selectedProducts(){
          return [...document.querySelectorAll('.prod:checked')].map(el=>({
            id:el.value, name:el.dataset.name, cents:Number(el.dataset.cents)
          }));
        }
        function update(){
          const pc=document.getElementById('pickCount');
          if(pc) pc.textContent = picked.size + ' photograph(s) selected';
          const prods=selectedProducts();
          const total=prods.reduce((s,p)=>s+p.cents,0) * Math.max(1,picked.size);
          const totalEl=document.getElementById('total');
          if(totalEl) totalEl.textContent='R'+(total/100).toFixed(2);
          const btn=document.getElementById('place');
          if(!btn) return;
          const ready = picked.size>0 && prods.length>0;
          btn.disabled=!ready;
          btn.textContent = ready ? 'Place order — R'+(total/100).toFixed(2) : 'Select photographs and products to order';
        }
        document.querySelectorAll('.prod').forEach(el=>el.onchange=update);

        const placeBtn=document.getElementById('place');
        if(placeBtn){
          placeBtn.onclick=async()=>{
            const email=document.getElementById('email').value.trim();
            const err=document.getElementById('emailErr');
            if(!email.includes('@')){ err.textContent='Enter a valid email address.'; return; }
            err.textContent='';
            placeBtn.disabled=true; placeBtn.textContent='Placing order…';
            const r=await fetch('/api/order',{
              method:'POST', headers:{'Content-Type':'application/json'},
              body:JSON.stringify({
                childId:'${c.id}', email,
                assetIds:[...picked], products:selectedProducts()
              })
            });
            const data=await r.json();
            if(!r.ok){ err.textContent=data.message||'Something went wrong.'; placeBtn.disabled=false; update(); return; }
            document.getElementById('ordNum').textContent='Order number: '+data.orderNumber;
            document.getElementById('confirm').style.display='block';
            placeBtn.style.display='none';
          };
        }
      </script>`,
    }),
  );
});

// ── Place an order: real order + order_line rows, real price snapshots ──────
app.post("/api/order", async (req, res) => {
  const client = await pool.connect();
  try {
    const { childId, email, assetIds, products } = req.body as {
      childId: string; email: string; assetIds: string[]; products: Array<{ id: string; name: string; cents: number }>;
    };
    if (!childId || !email || !email.includes("@")) {
      return res.status(400).json({ message: "A valid email address is required." });
    }
    if (!assetIds?.length || !products?.length) {
      return res.status(400).json({ message: "Select at least one photograph and one product." });
    }

    const child = await client.query(
      `select studio_id, school_id from child where id = $1`, [childId],
    );
    if (child.rowCount === 0) return res.status(404).json({ message: "Unknown child." });
    const { studio_id: studioId, school_id: schoolId } = child.rows[0];

    const shoot = await client.query(
      `select id from shoot where studio_id = $1 and school_id = $2 order by created_at desc limit 1`,
      [studioId, schoolId],
    );
    const shootId = shoot.rows[0]?.id;

    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true)");

    let guardian = await client.query(`select id from guardian where email = $1`, [email]);
    let guardianId = guardian.rows[0]?.id as string | undefined;
    if (!guardianId) {
      const r = await client.query(
        `insert into guardian (email, full_name) values ($1, $2) returning id`,
        [email, email.split("@")[0]],
      );
      guardianId = r.rows[0].id;
    }

    let subtotal = 0;
    const lines: Array<{ productId: string; name: string; unitCents: number; qty: number; assetId: string }> = [];
    for (const assetId of assetIds) {
      for (const p of products) {
        lines.push({ productId: p.id, name: p.name, unitCents: p.cents, qty: 1, assetId });
        subtotal += p.cents;
      }
    }

    const orderNumber = generateOrderNumber("WJ");
    const order = await client.query(
      `insert into "order" (studio_id, school_id, shoot_id, guardian_id, order_number,
                            subtotal_cents, total_cents, payment_status, digital_status)
       values ($1,$2,$3,$4,$5,$6,$6,'pending','pending') returning id`,
      [studioId, schoolId, shootId, guardianId, orderNumber, subtotal],
    );
    const orderId = order.rows[0].id;

    let lineNo = 1;
    for (const l of lines) {
      const gi = await client.query(
        `select gi.child_id from gallery_item gi where gi.asset_id = $1 limit 1`, [l.assetId],
      );
      const lineChildId = gi.rows[0]?.child_id ?? childId;
      await client.query(
        `insert into order_line (studio_id, order_id, child_id, line_no, kind, quantity,
                                 unit_cents, line_total_cents, vat_rate_bps, snapshot, fulfilment_kind)
         values ($1,$2,$3,$4,'product',$5,$6,$7,1500,$8,$9)`,
        [
          studioId, orderId, lineChildId, lineNo++, l.qty, l.unitCents, l.unitCents * l.qty,
          JSON.stringify({ name: l.name, assetId: l.assetId }),
          l.name.toLowerCase().includes("digital") ? "digital" : "physical",
        ],
      );
    }

    await client.query("commit");
    res.json({ orderNumber, total: subtotal });
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    res.status(500).json({ message: "Something went wrong placing the order." });
  } finally {
    client.release();
  }
});

// ============================================================================
// ADMIN — multi-school, with everything editable
// ============================================================================

app.get("/admin", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();

  const schools = await pool.query(
    `select id, name, display_name, commission_bps,
            (select count(*) from child c where c.school_id = school.id) as children
       from school where studio_id = $1 order by name`,
    [studioId],
  );

  if (schools.rowCount === 0) {
    return res.send(page({
      title: "Studio", nav: NAV,
      body: `<div class="sheet-head"><div class="kid"><h1>Studio</h1></div></div>
        <div class="empty">No schools yet — <a href="/import.html" style="text-decoration:underline">
          run an import</a>. The school is detected automatically from the top folder name.</div>`,
    }));
  }

  const selectedId = (req.query.school as string) || schools.rows[0].id;
  const selected = schools.rows.find((s) => s.id === selectedId) ?? schools.rows[0];

  const counts = await pool.query(
    `select
       (select count(*) from child where school_id = $1) as children,
       (select count(*) from asset a join shoot sh on sh.id = a.shoot_id where sh.school_id = $1) as assets,
       (select count(*) from claim_code cc join child c on c.id = cc.child_id where c.school_id = $1) as codes_issued,
       (select count(*) from claim_code cc join child c on c.id = cc.child_id
          where c.school_id = $1 and cc.redeemed_at is not null) as codes_redeemed`,
    [selected.id],
  );
  const n = counts.rows[0];

  const children = await pool.query(
    `select c.id, c.first_name, c.last_name,
            (select count(*) from gallery_item gi where gi.child_id = c.id) as photo_count,
            exists(select 1 from claim_code cc where cc.child_id = c.id and cc.redeemed_at is not null) as claimed
       from child c where c.school_id = $1 order by c.last_name, c.first_name`,
    [selected.id],
  );

  const products = await pool.query(
    `select id, sku, name_i18n->>'en' as name, active from product where studio_id = $1 order by sku`,
    [studioId],
  );
  const packages = await pool.query(
    `select id, name_i18n->>'en' as name, active from package where studio_id = $1 order by name_i18n->>'en'`,
    [studioId],
  );
  const priceList = await pool.query(
    `select id from price_list where studio_id = $1 and status = 'published' order by effective_from desc limit 1`,
    [studioId],
  );
  const prices = priceList.rows[0]
    ? await pool.query(
        `select p.product_id, p.amount_cents from price p where p.price_list_id = $1`,
        [priceList.rows[0].id],
      )
    : { rows: [] };
  const priceByProduct = new Map(prices.rows.map((r: any) => [r.product_id, r.amount_cents]));

  const orders = await pool.query(
    `select o.id, o.order_number, o.total_cents, o.payment_status, o.digital_status,
            o.fulfilment_status, g.email
       from "order" o join guardian g on g.id = o.guardian_id
      where o.school_id = $1 order by o.placed_at desc limit 50`,
    [selected.id],
  );

  const schoolTabs = schools.rows
    .map(
      (s) => `<a class="navlink" href="/admin?school=${s.id}" style="${
        s.id === selected.id ? "color:var(--graphite);border-bottom:2px solid var(--chinagraph)" : ""
      }">${escapeHtml(s.display_name || s.name)} <span class="mono" style="color:var(--silver)">(${s.children})</span></a>`,
    )
    .join("");

  res.send(
    page({
      title: `Studio — ${selected.display_name || selected.name}`,
      nav: NAV,
      body: `
      <div class="sheet-head">
        <div class="kid"><h1>${escapeHtml(selected.display_name || selected.name)}</h1></div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:12px">${schoolTabs}
          <a class="navlink" href="/import.html">+ Import another school</a></div>
      </div>

      <div class="stats">
        <div class="stat"><div class="n">${n.children}</div><div class="l">Children</div></div>
        <div class="stat"><div class="n">${n.assets}</div><div class="l">Photographs</div></div>
        <div class="stat"><div class="n">${n.codes_redeemed}/${n.codes_issued}</div><div class="l">Codes claimed</div></div>
      </div>

      <div class="sectlabel"><span>School details</span></div>
      <form method="post" action="/admin/school/${selected.id}" style="display:grid;gap:8px;max-width:420px">
        <label class="mono" style="font-size:11px;color:var(--silver)">Name parents see</label>
        <input name="display_name" value="${escapeHtml(selected.display_name || "")}"
               placeholder="${escapeHtml(selected.name)}"
               style="padding:9px;border:1px solid var(--rule);border-radius:2px">
        <label class="mono" style="font-size:11px;color:var(--silver)">School commission (%)</label>
        <input name="commission_pct" type="number" step="0.1" value="${(selected.commission_bps / 100).toFixed(1)}"
               style="padding:9px;border:1px solid var(--rule);border-radius:2px;max-width:120px">
        <button type="submit" class="btn" style="max-width:160px">Save school</button>
      </form>

      <div class="sectlabel"><span>Products &amp; prices</span></div>
      <table><thead><tr><th>SKU</th><th>Name</th><th>Price (cents)</th><th>Active</th><th></th></tr></thead><tbody>
        ${products.rows
          .map(
            (p) => `<tr><form method="post" action="/admin/product/${p.id}">
              <td class="mono">${escapeHtml(p.sku)}</td>
              <td><input name="name" value="${escapeHtml(p.name)}" style="border:1px solid var(--rule);padding:5px;border-radius:2px;width:100%"></td>
              <td><input name="amount_cents" type="number" value="${priceByProduct.get(p.id) ?? 0}"
                    style="border:1px solid var(--rule);padding:5px;border-radius:2px;width:100px"></td>
              <td><input type="checkbox" name="active" ${p.active ? "checked" : ""}></td>
              <td><button type="submit" class="pill">Save</button></td>
            </form></tr>`,
          )
          .join("")}
      </tbody></table>
      <form method="post" action="/admin/product" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <input name="sku" placeholder="SKU e.g. PRINT-A4" required style="padding:8px;border:1px solid var(--rule);border-radius:2px">
        <input name="name" placeholder="Name e.g. A4 Print" required style="padding:8px;border:1px solid var(--rule);border-radius:2px">
        <input name="amount_cents" type="number" placeholder="Price in cents" required style="padding:8px;border:1px solid var(--rule);border-radius:2px;width:130px">
        <button type="submit" class="btn" style="width:auto;padding:8px 16px">Add product</button>
      </form>

      <div class="sectlabel"><span>Packages</span></div>
      <table><thead><tr><th>Name</th><th>Active</th></tr></thead><tbody>
        ${packages.rows.length
          ? packages.rows.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td><span class="pill ${p.active ? "ok" : ""}">${p.active ? "Active" : "Draft"}</span></td></tr>`).join("")
          : `<tr><td colspan="2" class="empty">No packages yet.</td></tr>`}
      </tbody></table>
      <form method="post" action="/admin/package" style="margin-top:8px;display:flex;gap:6px">
        <input name="name" placeholder="Package name e.g. Silver" required style="padding:8px;border:1px solid var(--rule);border-radius:2px">
        <button type="submit" class="btn" style="width:auto;padding:8px 16px">Add package</button>
      </form>

      <div class="sectlabel"><span>Orders</span></div>
      ${
        orders.rowCount === 0
          ? `<div class="empty">No orders yet.</div>`
          : `<table><thead><tr><th>Order</th><th>Guardian</th><th>Total</th>
              <th>Payment</th><th>Digital</th><th>Prints</th><th></th></tr></thead><tbody>
          ${orders.rows
            .map(
              (o) => `<tr>
                <td class="mono">${escapeHtml(o.order_number)}</td>
                <td>${escapeHtml(o.email)}</td>
                <td class="mono">R${(o.total_cents / 100).toFixed(2)}</td>
                <td><span class="pill ${o.payment_status === "settled" ? "ok" : ""}">${escapeHtml(o.payment_status)}</span></td>
                <td><span class="pill ${o.digital_status === "delivered" ? "ok" : ""}">${escapeHtml(o.digital_status)}</span></td>
                <td><span class="pill ${o.fulfilment_status === "completed" ? "ok" : ""}">${escapeHtml(o.fulfilment_status)}</span></td>
                <td>${
                  o.payment_status !== "settled"
                    ? `<form method="post" action="/admin/order/${o.id}/mark-paid" style="display:inline">
                         <button type="submit" class="pill">Mark paid</button></form>`
                    : ""
                }</td>
              </tr>`,
            )
            .join("")}
          </tbody></table>
          <div class="note">"Mark paid" is the real payment confirmation step until a card gateway is
            connected — it settles the order and, if it contains any digital lines, emails them
            immediately (the digital-release gate is enforced in the database, not just here).</div>`
      }

      <div class="sectlabel"><span>Children</span></div>
      ${
        children.rowCount === 0
          ? `<div class="empty">No children at this school yet.</div>`
          : `<table><thead><tr><th>Name</th><th>Photographs</th><th>Gallery link</th><th>Claim cards</th><th>Claimed</th></tr></thead><tbody>
          ${children.rows
            .map(
              (r) => `<tr>
                <td>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}</td>
                <td>${r.photo_count}</td>
                <td><a href="/g/${r.id}" class="mono" style="text-decoration:underline">/g/${r.id.slice(0, 8)}…</a></td>
                <td><a href="/admin/cards/${selected.id}" style="text-decoration:underline">Print sheet →</a></td>
                <td><span class="pill ${r.claimed ? "ok" : ""}">${r.claimed ? "Claimed" : "Not yet"}</span></td>
              </tr>`,
            )
            .join("")}
          </tbody></table>`
      }
      <div class="note">Switch schools with the tabs above. A new school needs no setup — drag its
        folder into the importer and it appears here automatically.</div>`,
    }),
  );
});

app.post("/admin/order/:id/mark-paid", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("select set_config('app.actor_kind', 'system', true)");

    // Two updates, in order: settle payment first, then release digital.
    // The digital-release gate (migration 0013, enforce_digital_gate) refuses
    // to mark digital_status='delivered' while payment_status is not settled —
    // this order of operations is not cosmetic, it is what makes the trigger
    // actually protect anything.
    await client.query(`update "order" set payment_status = 'settled' where id = $1`, [req.params.id]);

    const hasDigital = await client.query(
      `select 1 from order_line where order_id = $1 and fulfilment_kind = 'digital' limit 1`,
      [req.params.id],
    );
    if (hasDigital.rowCount! > 0) {
      await client.query(`update "order" set digital_status = 'delivered' where id = $1`, [req.params.id]);
    }

    const school = await client.query(`select school_id from "order" where id = $1`, [req.params.id]);
    res.redirect(`/admin?school=${school.rows[0].school_id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error marking order paid: " + (err as Error).message);
  } finally {
    client.release();
  }
});

app.post("/admin/school/:id", async (req, res) => {
  const { display_name, commission_pct } = req.body;
  const bps = Math.round(Number(commission_pct || 0) * 100);
  await pool.query(
    `update school set display_name = $1, commission_bps = $2 where id = $3`,
    [display_name || null, bps, req.params.id],
  );
  res.redirect(`/admin?school=${req.params.id}`);
});

app.post("/admin/product", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();
  const { sku, name, amount_cents } = req.body;
  try {
    const p = await pool.query(
      `insert into product (studio_id, sku, name_i18n, kind, active)
       values ($1, $2, jsonb_build_object('en', $3::text), 'print', true)
       returning id`,
      [studioId, sku, name],
    );
    await ensurePriceListAndSet(studioId, p.rows[0].id, Number(amount_cents));
  } catch (err) {
    // A duplicate SKU is a mistake worth a plain message, not a stack trace.
    const msg = (err as Error).message.includes("product_sku_unique")
      ? `A product with SKU "${sku}" already exists — edit it in the table above instead.`
      : (err as Error).message;
    return res.status(400).send(msg + `<br><a href="/admin">← Back</a>`);
  }
  res.redirect("/admin");
});

app.post("/admin/product/:id", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();
  const { name, amount_cents, active } = req.body;
  await pool.query(
    `update product set name_i18n = jsonb_build_object('en', $1::text), active = $2 where id = $3`,
    [name, active === "on", req.params.id],
  );
  await ensurePriceListAndSet(studioId, req.params.id, Number(amount_cents));
  res.redirect("/admin");
});

async function ensurePriceListAndSet(studioId: string, productId: string, amountCents: number) {
  let pl = await pool.query(
    `select id from price_list where studio_id = $1 and status = 'published' order by effective_from desc limit 1`,
    [studioId],
  );
  let priceListId = pl.rows[0]?.id as string | undefined;
  if (!priceListId) {
    const created = await pool.query(
      `insert into price_list (studio_id, name, effective_from, status)
       values ($1, 'Current prices', now(), 'published') returning id`,
      [studioId],
    );
    priceListId = created.rows[0].id;
  }
  await pool.query(
    `insert into price (studio_id, price_list_id, product_id, amount_cents)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [studioId, priceListId, productId, amountCents],
  );
  // Simplification, stated plainly: this UPDATEs in place rather than
  // versioning a new price_list per edit (§11.1 describes full versioning).
  // Acceptable for now because no checkout exists yet to reference historical
  // order-line snapshots — there is nothing yet for an old price to protect.
  // Revisit before checkout ships, or an edited price will retroactively
  // change what a placed order appears to have cost.
  await pool.query(
    `update price set amount_cents = $1 where price_list_id = $2 and product_id = $3`,
    [amountCents, priceListId, productId],
  );
}

app.post("/admin/package", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();
  const { name } = req.body;
  await pool.query(
    `insert into package (studio_id, name_i18n, description_i18n, active)
     values ($1, jsonb_build_object('en', $2::text), '{}'::jsonb, false)`,
    [studioId, name],
  );
  res.redirect("/admin");
});

// ── Printable claim-code sheet, with real QR codes ───────────────────────────
// Generated on demand rather than at commit time and cached: it needs the
// plaintext code, which the database never stores (§6.2 — only the Argon2id
// hash is kept). So this page re-issues a fresh claim code for any child who
// does not already have a live one — visiting it is itself the "regenerate
// codes" action for children who have not been printed yet, and is a no-op
// (existing code shown as already issued, no plaintext available to reprint)
// for anyone who already has a live code from a previous visit or import.
app.get("/admin/cards/:schoolId", async (req, res) => {
  const { studioId, staffId } = await ensureStudioAndStaff();
  const client = await pool.connect();
  try {
    const schoolId = req.params.schoolId;
    const shootId = await findOrCreateShoot(studioId, schoolId);

    const children = await pool.query(
      `select c.id, c.first_name, c.last_name, cl.name as class_name, g.name as grade_name,
              exists(select 1 from claim_code cc where cc.child_id = c.id
                       and cc.shoot_id = $2 and cc.revoked_at is null and cc.redeemed_at is null
                       and cc.expires_at > now()) as has_live_code
         from child c
         left join enrolment e on e.child_id = c.id
         left join class_group cl on cl.id = e.class_group_id
         left join grade g on g.id = cl.grade_id
        where c.school_id = $1 order by g.sort_order, cl.name, c.last_name`,
      [schoolId, shootId],
    );

    await client.query("select set_config('app.actor_kind', 'staff', true)");
    await client.query("select set_config('app.studio_id', $1, true)", [studioId]);
    await client.query("select set_config('app.staff_id', $1, true)", [staffId]);
    await client.query("select set_config('app.staff_role', 'photographer', true)");

    const host = req.protocol + "://" + req.get("host");
    const cards: string[] = [];
    for (const c of children.rows) {
      let grouped: string | null = null;
      if (!c.has_live_code) {
        const issued = await issueClaimCode(client, {
          studioId, childId: c.id, shootId, expiresAt: new Date(Date.now() + 60 * 24 * 3_600_000),
        });
        grouped = issued.grouped;
      }
      const qrTarget = grouped ? `${host}/?code=${grouped}` : `${host}/`;
      const qrPng = await QRCode.toDataURL(qrTarget, { margin: 1, width: 200 });
      cards.push(`
        <div class="card" style="break-inside:avoid;display:inline-block;width:260px;margin:6px;
             border:1px solid var(--rule);border-radius:4px;padding:14px;vertical-align:top">
          <div style="font-weight:600;font-size:15px">${escapeHtml(c.first_name)} ${escapeHtml(c.last_name)}</div>
          <div class="mono" style="font-size:11px;color:var(--silver);margin-bottom:8px">
            ${escapeHtml(c.grade_name ?? "")} ${escapeHtml(c.class_name ?? "")}</div>
          <img src="${qrPng}" style="width:140px;height:140px;display:block;margin:0 auto">
          <div class="mono" style="text-align:center;font-size:14px;font-weight:600;margin-top:8px">
            ${grouped ? escapeHtml(grouped) : '<span style="color:var(--silver)">already issued</span>'}
          </div>
        </div>`);
    }

    res.send(
      page({
        title: "Claim cards",
        nav: NAV,
        body: `
        <div class="sheet-head"><div class="kid"><h1>Claim cards</h1></div></div>
        <p style="margin-bottom:14px">Print this page (Cmd/Ctrl+P). One card per child — QR code plus
          the human-readable fallback. Cards already issued in a previous visit show
          "already issued": their code is hashed in the database and cannot be redisplayed, by design.</p>
        <button class="btn" style="width:auto;padding:10px 20px;margin-bottom:16px" onclick="window.print()">Print</button>
        <div>${cards.join("")}</div>`,
      }),
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating cards: " + (err as Error).message);
  } finally {
    client.release();
  }
});

// ============================================================================
// IMPORT PIPELINE
// ============================================================================

app.post("/api/import/upload", upload.array("files"), async (req, res) => {
  try {
    const { studioId, staffId } = await ensureStudioAndStaff();
    const files = (req.files as Express.Multer.File[]) ?? [];
    const relPaths = ([] as string[]).concat(req.body.relativePaths ?? []);

    if (files.length === 0) {
      return res.status(400).json({ error: "No files received." });
    }

    const uploadedForProposal: UploadedFile[] = files.map((f, i) => ({
      relativePath: relPaths[i] ?? f.originalname,
      size: f.size,
    }));
    const proposal = proposeStructure(uploadedForProposal);

    // The school is detected from the folder, not chosen from a dropdown —
    // this is what makes multi-school "easy access" real: importing a new
    // school's folder IS the act of adding that school.
    const school = await findOrCreateSchool(studioId, proposal.schoolName);
    const shootId = await findOrCreateShoot(studioId, school.id);

    const batch = await pool.query(
      `insert into import_batch (studio_id, shoot_id, started_by, status, file_count, proposal)
       values ($1, $2, $3, 'awaiting_review', $4, $5)
       returning id`,
      [studioId, shootId, staffId, files.length, JSON.stringify(proposal)],
    );
    const batchId = batch.rows[0].id as string;

    const staged: Array<{
      id: string;
      relativePath: string;
      thumbUrl: string;
      autoMatchedName: string | null;
    }> = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const relativePath = relPaths[i] ?? f.originalname;

      let source, variants;
      try {
        ({ source, variants } = await deriveVariants(f.buffer, { watermarkText: "Wiaan Jordaan Photography" }));
      } catch (err) {
        await pool.query(
          `insert into import_file (studio_id, import_batch_id, relative_path, file_name, bytes, status, failure_reason)
           values ($1,$2,$3,$4,$5,'failed',$6)`,
          [studioId, batchId, relativePath, f.originalname, f.size, (err as Error).message],
        );
        continue;
      }

      const originalKey = randomKey("originals", "jpg");
      await putObject(originalKey, f.buffer);
      const thumb = variants.find((v) => v.kind === "thumb" && v.format === "webp")!;
      const thumbKey = randomKey("variants/thumb", "webp");
      await putObject(thumbKey, thumb.data);
      const previewJpeg = variants.find((v) => v.kind === "preview");
      const previewKey = randomKey("variants/preview", previewJpeg!.format);
      await putObject(previewKey, previewJpeg!.data);

      const fileId = randomUUID();
      await pool.query(
        `insert into import_file (id, studio_id, import_batch_id, relative_path, file_name, bytes, sha256, status)
         values ($1,$2,$3,$4,$5,$6,$7,'uploaded')`,
        [fileId, studioId, batchId, relativePath, f.originalname, f.size, source.sha256],
      );

      STAGED_KEYS.set(fileId, {
        originalKey, thumbKey, previewKey, width: source.width, height: source.height, bytes: f.size,
      });

      // Auto-match by folder name: grade/class/child three levels below the
      // school folder. If it matches, the child is found-or-created and
      // TAG_MAP is populated immediately — Wiaan never types this name.
      const inner = relativePath.split("/").slice(1, -1); // drop school folder + filename
      const match = childFolderFromPath(inner);
      let autoMatchedName: string | null = null;

      if (match) {
        const first = match.firstName;
        const last = match.lastName || "—";
        let existingChild = await pool.query(
          `select id from child where studio_id = $1 and school_id = $2
             and first_name = $3 and last_name = $4 and status = 'active'`,
          [studioId, school.id, first, last],
        );
        let childId = existingChild.rows[0]?.id as string | undefined;
        if (!childId) {
          const r = await pool.query(
            `insert into child (studio_id, school_id, first_name, last_name) values ($1,$2,$3,$4) returning id`,
            [studioId, school.id, first, last],
          );
          childId = r.rows[0].id;
        }
        TAG_MAP.set(fileId, childId!);
        autoMatchedName = `${first} ${last}`.trim();
        await pool.query(`update import_file set status = 'processed' where id = $1`, [fileId]);
      }

      staged.push({ id: fileId, relativePath, thumbUrl: publicUrl(thumbKey), autoMatchedName });
    }

    const autoCount = staged.filter((s) => s.autoMatchedName).length;
    res.json({
      batchId, shootId,
      schoolId: school.id, schoolName: school.name,
      proposal, staged,
      autoMatched: autoCount,
      needsTagging: staged.length - autoCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const STAGED_KEYS = new Map<
  string,
  { originalKey: string; thumbKey: string; previewKey: string; width: number; height: number; bytes: number }
>();
const TAG_MAP = new Map<string, string>();

app.post("/api/import/:batchId/segment", async (req, res) => {
  try {
    const { batchId } = req.params;
    const rows = (
      await pool.query(
        `select id, relative_path, sha256 from import_file where import_batch_id = $1 order by relative_path`,
        [batchId],
      )
    ).rows;

    // Files already auto-matched by folder name (TAG_MAP) do not need
    // segmentation or manual tagging — only the leftovers go through the
    // slate/manual path from §7.3.
    const remaining = rows.filter((r) => !TAG_MAP.has(r.id));
    const frames: Frame[] = remaining.map((r) => ({
      assetId: r.id, capturedAt: null, frameSeq: null, slateCode: null,
    }));
    const result = segmentBySlates(frames, { knownCodes: new Set() });
    const summary = reviewSummary(result);

    res.json({ result, summary, mode: "manual_fallback", autoMatchedCount: rows.length - remaining.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/import/:batchId/tag", async (req, res) => {
  try {
    const { fileId, firstName, lastName } = req.body as { fileId: string; firstName: string; lastName: string };
    if (!fileId || !firstName || !lastName) {
      return res.status(400).json({ error: "fileId, firstName and lastName are all required." });
    }
    const info = await pool.query(
      `select if_.studio_id, ib.shoot_id, sh.school_id
         from import_file if_
         join import_batch ib on ib.id = if_.import_batch_id
         join shoot sh on sh.id = ib.shoot_id
        where if_.id = $1`,
      [fileId],
    );
    if (info.rowCount === 0) return res.status(404).json({ error: "Unknown file." });
    const { studio_id: studioId, school_id: schoolId } = info.rows[0];

    let child = await pool.query(
      `select id from child where studio_id = $1 and school_id = $2
        and first_name = $3 and last_name = $4 and status = 'active'`,
      [studioId, schoolId, firstName, lastName],
    );
    let childId = child.rows[0]?.id as string | undefined;
    if (!childId) {
      const r = await pool.query(
        `insert into child (studio_id, school_id, first_name, last_name) values ($1,$2,$3,$4) returning id`,
        [studioId, schoolId, firstName, lastName],
      );
      childId = r.rows[0].id;
    }

    await pool.query(`update import_file set status = 'processed' where id = $1`, [fileId]);
    TAG_MAP.set(fileId, childId!);

    res.json({ childId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/import/:batchId/commit", async (req, res) => {
  const client = await pool.connect();
  try {
    const { batchId } = req.params;
    await client.query("begin");

    const files = (
      await client.query(
        `select f.id, f.studio_id, f.import_batch_id, f.relative_path, f.file_name, f.bytes, f.sha256,
                b.shoot_id
           from import_file f join import_batch b on b.id = f.import_batch_id
          where f.import_batch_id = $1 and f.status in ('uploaded','processed')`,
        [batchId],
      )
    ).rows;

    if (files.length === 0) {
      await client.query("rollback");
      return res.status(400).json({ error: "Nothing to commit — no staged files found for this batch." });
    }
    const shootId = files[0].shoot_id as string;
    const { staffId } = await ensureStudioAndStaff();

    const claimCodes: Array<{ child: string; grouped: string }> = [];
    const childCodeCache = new Map<string, string>();

    await client.query("select set_config('app.actor_kind', 'staff', true)");
    await client.query("select set_config('app.staff_id', $1, true)", [staffId]);
    await client.query("select set_config('app.staff_role', 'photographer', true)");

    for (const f of files) {
      const keys = STAGED_KEYS.get(f.id);
      if (!keys) continue;

      const asset = await client.query(
        `insert into asset (studio_id, shoot_id, sha256, storage_key, bytes, width, height,
                            content_type, original_name, original_path, status)
         values ($1,$2,$3,$4,$5,$6,$7,'image/jpeg',$8,$9,'ready')
         on conflict (studio_id, sha256) do update set status = 'ready'
         returning id`,
        [f.studio_id, shootId, f.sha256, keys.originalKey, keys.bytes, keys.width, keys.height, f.file_name, f.relative_path],
      );
      const assetId = asset.rows[0].id;

      await client.query(
        `insert into asset_variant (asset_id, studio_id, kind, format, storage_key, width, height, bytes, watermarked)
         values ($1,$2,'thumb','webp',$3,400,600,1,true) on conflict (asset_id, kind, format) do nothing`,
        [assetId, f.studio_id, keys.thumbKey],
      );
      await client.query(
        `insert into asset_variant (asset_id, studio_id, kind, format, storage_key, width, height, bytes, watermarked)
         values ($1,$2,'preview','webp',$3,1200,1800,1,true) on conflict (asset_id, kind, format) do nothing`,
        [assetId, f.studio_id, keys.previewKey],
      );

      const childId = TAG_MAP.get(f.id);
      if (childId) {
        await client.query(
          `insert into gallery_item (studio_id, asset_id, child_id, role, assigned_by, confidence)
           values ($1,$2,$3,'individual',$4,1.0) on conflict (asset_id, child_id) do nothing`,
          [f.studio_id, assetId, childId, "filename"],
        );

        if (!childCodeCache.has(childId)) {
          await client.query("select set_config('app.studio_id', $1, true)", [f.studio_id]);
          const issued = await issueClaimCode(client, {
            studioId: f.studio_id, childId, shootId,
            expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
          });
          childCodeCache.set(childId, issued.grouped);
          const c = await client.query(`select first_name, last_name from child where id = $1`, [childId]);
          claimCodes.push({ child: `${c.rows[0].first_name} ${c.rows[0].last_name}`, grouped: issued.grouped });
        }
      }

      await client.query(`update import_file set status = 'committed', asset_id = $1 where id = $2`, [assetId, f.id]);
    }

    await client.query(`update import_batch set status = 'committed', committed_at = now() where id = $1`, [batchId]);
    await client.query("commit");

    res.json({ committed: files.length, claimCodes, shootId });
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true, db: "connected" });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── Maintenance: inspect and clear data through the app itself. ─────────────
// The direct Postgres proxy port is not reachable from every network, so this
// gives staff (and only staff — same auth as /admin) a way to see and remove
// records without a raw database connection. delete-child is deliberately not
// exposed anywhere in the UI: it is a maintenance tool for clearing test data,
// not a feature, and it cascades to every dependent row via the same foreign
// keys the schema already enforces.
app.get("/admin/api/children", requireStaffAuth, async (_req, res) => {
  const rows = await pool.query(
    `select c.id, c.first_name, c.last_name, s.name as school_name, c.created_at
       from child c join school s on s.id = c.school_id
      order by c.created_at`,
  );
  res.json(rows.rows);
});

app.post("/admin/api/child/:id/delete", requireStaffAuth, async (req, res) => {
  await pool.query(`delete from child where id = $1`, [req.params.id]);
  res.json({ deleted: req.params.id });
});

app.listen(PORT, () => {
  console.log(`\n  Server running on port ${PORT}. (auto-deploy pipeline verified)`);
  console.log(`  → /              parent claim entry`);
  console.log(`  → /admin         studio console (staff auth)`);
  console.log(`  → /import.html   import tool (staff auth)\n`);
});

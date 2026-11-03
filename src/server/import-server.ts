import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

import { proposeStructure, similarity, parseGrade, parseClass, compactName, type UploadedFile } from "../lib/import/folders.js";
import { childFolderFromPath } from "../lib/import/childfolder.js";
import { segmentBySlates, reviewSummary, type Frame } from "../lib/import/segment.js";
import { deriveVariants } from "../lib/media/derive.js";
import { putObject, publicUrl, randomKey } from "../lib/storage/local.js";
import { issueClaimCode, redeemClaimCode, completeClaim } from "../lib/claim.js";
import { generateOrderNumber, normaliseCode } from "../lib/ids.js";
import { page, escapeHtml } from "./views.js";
import { formatRands, parseRands, randsInputValue, FORMAT_RANDS_JS } from "../lib/commerce/money.js";
import { getObject } from "../lib/storage/local.js";
import { migrateOnBoot } from "./migrate.js";
import {
  readParentSession, sessionCanViewChild, createAnonymousGuardian, grantChildToBrowser,
  probeRlsRole, rlsEnforcedForParents, asGuardianRls, type ParentSession,
} from "./parent-auth.js";
import {
  WEBHOOK_PATH, handleYocoWebhook, startCheckout, settleOrder, saveYocoKey, yocoStatus, ensureYocoWebhook,
} from "./payments.js";

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

// Railway terminates TLS at one proxy hop. Without this, req.ip is the
// proxy's address for every parent — so five wrong codes from ANYONE tripped
// the claim rate limit for EVERY parent for 15 minutes — and req.secure is
// false, so the session cookie could not be marked Secure.
app.set("trust proxy", 1);

// The Yoco webhook must see the exact bytes Yoco signed, so it is mounted
// with a raw body parser BEFORE express.json() gets a chance to consume it.
app.post(WEBHOOK_PATH, express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const status = await handleYocoWebhook(pool, req.headers, raw, req.ip);
  res.status(status).json({ ok: status < 300 });
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use((req, _res, next) => {
  const raw = req.headers.cookie ?? "";
  (req as any).cookies = Object.fromEntries(
    raw.split(";").map((p) => {
      const t = p.trim();
      const i = t.indexOf("=");
      if (i < 0) return [t, ""];
      let v = t.slice(i + 1);
      try { v = decodeURIComponent(v); } catch { /* keep raw */ }
      return [t.slice(0, i), v];
    }).filter((p) => p[0]),
  );
  next();
});

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? new URL("../../storage", import.meta.url).pathname;

/**
 * Security headers.
 *
 * Cheap, and they close off whole categories of attack: clickjacking (an
 * attacker framing the parent gallery to harvest clicks), MIME sniffing (a
 * malicious upload being reinterpreted as script), and referrer leakage (a
 * child's gallery URL travelling to third parties in the Referer header —
 * which matters here because that URL is currently the only thing protecting
 * the gallery).
 */
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

/**
 * Serve ONLY derived, watermarked variants over HTTP — never originals.
 *
 * `express.static(STORAGE_ROOT)` served the entire storage tree, including
 * `originals/`: full-resolution, unwatermarked, unpaid-for photographs of
 * children, downloadable by anyone who learned a filename. The random 128-bit
 * filename made guessing impractical, but that is precisely the "unguessable
 * URL as security" model §6.6 rejects — a URL leaks through browser history,
 * shared links, and Referer headers, and once leaked it is permanent because
 * nothing checks who is asking.
 *
 * Originals now have no HTTP route at all. They are reachable only through
 * code, which is where the paid-download grant check belongs when digital
 * delivery is wired up.
 */
app.use("/storage/variants", express.static(STORAGE_ROOT + "/variants", {
  // Content-addressed keys never change meaning, so they cache hard.
  maxAge: "7d",
  immutable: true,
}));

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

  await ensureDefaultCatalogue(studioId!);

  return { studioId: studioId!, staffId: staffId! };
}

/**
 * Seed a working catalogue the first time the studio exists.
 *
 * Without this, a fresh import produced children, galleries and QR codes —
 * and then a parent opening the gallery saw "No products are priced yet" and
 * could buy nothing. Every price and product had to be typed in by hand
 * before the site did anything useful, which is exactly the manual setup this
 * product exists to remove.
 *
 * These are real, editable rows, not hardcoded behaviour: prices come from
 * Wiaan's published price list, and everything here can be renamed, repriced,
 * deactivated or deleted from the admin Settings page. They exist so the
 * system works out of the box, and so his first job is *adjusting* a working
 * catalogue rather than *building* one from nothing.
 *
 * Runs once and is idempotent — the `exists` guard means restarting the
 * server or importing a second school never duplicates or resets anything
 * Wiaan has since edited.
 */
async function ensureDefaultCatalogue(studioId: string): Promise<void> {
  const existing = await pool.query(`select 1 from product where studio_id = $1 limit 1`, [studioId]);
  if (existing.rowCount! > 0) return;

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Print sizes, as data — §11.5. Millimetres stored so aspect ratio and the
    // minimum-resolution warning derive automatically.
    const sizes: Array<[string, number, number]> = [
      ["10×15", 100, 150],
      ["A5", 148, 210],
      ["A4", 210, 297],
      ["A3", 297, 420],
    ];
    for (const [label, w, h] of sizes) {
      await client.query(
        `insert into print_size (studio_id, label, width_mm, height_mm)
         values ($1,$2,$3,$4) on conflict (studio_id, label) do nothing`,
        [studioId, label, w, h],
      );
    }

    const priceList = await client.query(
      `insert into price_list (studio_id, name, effective_from, status)
       values ($1, 'Standard prices', now(), 'published') returning id`,
      [studioId],
    );
    const priceListId = priceList.rows[0].id;

    // Starting prices in cents, VAT-inclusive (§11.3 — consumers see one
    // number). Wiaan will almost certainly change these; that is the point.
    const products: Array<[string, string, string, number]> = [
      ["PRINT-10X15", "10×15 Print", "print", 4500],
      ["PRINT-A5", "A5 Print", "print", 7500],
      ["PRINT-A4", "A4 Print", "print", 14500],
      ["PRINT-A3", "A3 Print", "print", 26500],
      ["DIGITAL-single", "Digital Image", "digital_single", 9500],
      ["DIGITAL-gallery", "Full Digital Gallery", "digital_gallery", 32000],
      ["MUG", "Photo Mug", "merch", 18000],
      ["KEYRING", "Keyring", "merch", 6500],
      ["MAGNET", "Fridge Magnet", "merch", 5500],
      ["CANVAS", "Canvas 30×40", "merch", 49500],
    ];
    for (const [sku, name, kind, cents] of products) {
      const p = await client.query(
        `insert into product (studio_id, sku, name_i18n, kind, active)
         values ($1,$2, jsonb_build_object('en', $3::text), $4, true)
         on conflict (studio_id, sku) do nothing returning id`,
        [studioId, sku, name, kind],
      );
      if (p.rows[0]) {
        await client.query(
          `insert into price (studio_id, price_list_id, product_id, amount_cents)
           values ($1,$2,$3,$4)`,
          [studioId, priceListId, p.rows[0].id, cents],
        );
      }
    }

    // Packages, priced below the sum of their parts so the saving is real
    // (§9 — the saving is what does the selling, so it must be honest).
    const packages: Array<[string, string, number]> = [
      ["Bronze", "2 × 10×15 prints and 1 digital image", 24500],
      ["Silver", "5 mixed prints, 2 keyrings and the full digital gallery", 48500],
      ["Gold", "Canvas, mug, keyring, full digital gallery and 4 × A5 prints", 89500],
    ];
    for (const [name, desc, cents] of packages) {
      const pkg = await client.query(
        `insert into package (studio_id, name_i18n, description_i18n, active)
         values ($1, jsonb_build_object('en', $2::text), jsonb_build_object('en', $3::text), true)
         returning id`,
        [studioId, name, desc],
      );
      await client.query(
        `insert into price (studio_id, price_list_id, package_id, amount_cents)
         values ($1,$2,$3,$4)`,
        [studioId, priceListId, pkg.rows[0].id, cents],
      );
    }

    await client.query("commit");
    console.log("  Seeded default catalogue (10 products, 3 packages, 4 print sizes).");
  } catch (err) {
    await client.query("rollback");
    console.error("Failed to seed default catalogue:", (err as Error).message);
  } finally {
    client.release();
  }
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
// Parents never see links into the staff area.
const PARENT_NAV = ``;

// ── Home: claim code entry ───────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send(
    page({
      title: "Find your child's photographs",
      nav: PARENT_NAV,
      body: `
      <div class="claim">
        <h1>Find your child's<br>photographs</h1>
        <p>Scan the QR code on your child's card, or type the code printed under it.</p>
        <div class="codebox">
          <input class="g4 mono" id="c1" maxlength="4" placeholder="XXXX" autocomplete="off">
          <input class="g3 mono" id="c2" maxlength="3" placeholder="XXX" autocomplete="off">
          <input class="g3 mono" id="c3" maxlength="3" placeholder="XXX" autocomplete="off">
        </div>
        <div class="err" id="err"></div>
        <button class="btn" id="go">Show me the photographs</button>
      </div>
      <div class="how">
        <div><b>01</b><p>Enter the code from the card your child brought home.</p></div>
        <div><b>02</b><p>Choose your favourite photographs and a package or prints.</p></div>
        <div><b>03</b><p>Pay securely. Digital copies download immediately; prints are delivered to the school.</p></div>
      </div>
      <p class="helpline">Lost the card or the code doesn't work? Contact the studio via
        <a href="https://wjphotography.co.za" style="text-decoration:underline">wjphotography.co.za</a>.</p>
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
        // Pasting the whole code into any box fills all three; Enter submits.
        ['c1','c2','c3'].forEach(id=>{
          $(id).addEventListener('paste',e=>{
            const t=(e.clipboardData.getData('text')||'').toUpperCase().replace(/[^0-9A-Z]/g,'');
            if(t.length>=10){ e.preventDefault(); $('c1').value=t.slice(0,4); $('c2').value=t.slice(4,7); $('c3').value=t.slice(7,10); $('go').focus(); }
          });
          $(id).addEventListener('keydown',e=>{ if(e.key==='Enter') $('go').click(); });
        });
        // The QR code on the printed card opens /?code=XXXX-XXX-XXX: fill the
        // boxes and go straight through, so a scan is one tap, not a retype.
        const fromQr=(new URLSearchParams(location.search).get('code')||'')
          .toUpperCase().replace(/[^0-9A-Z]/g,'');
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
        if(fromQr.length===10){
          $('c1').value=fromQr.slice(0,4); $('c2').value=fromQr.slice(4,7); $('c3').value=fromQr.slice(7);
          history.replaceState(null,'','/');
          $('go').click();
        }
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
    const ip = req.ip ?? "0.0.0.0";

    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true)");

    // Only try shoots that actually hold a code with this hint. Trying every
    // open shoot logged a "not_found" attempt for each school the code was
    // NOT from — so with six schools open, one parent's valid code counted
    // as five failures and locked out everyone on that IP (school wifi) for
    // 15 minutes. With no candidate at all, one attempt is still made so the
    // miss is recorded and rate-limited exactly once.
    const hint = normaliseCode(code ?? "").slice(-3);
    let shoots = await client.query(
      `select distinct sh.id from shoot sh join claim_code cc on cc.shoot_id = sh.id
        where sh.studio_id = $1 and sh.status = 'open' and cc.code_hint = $2`,
      [studioId, hint],
    );
    if (shoots.rowCount === 0) {
      shoots = await client.query(
        `select id from shoot where studio_id = $1 and status = 'open' limit 1`, [studioId],
      );
    }

    let result: Awaited<ReturnType<typeof redeemClaimCode>> | null = null;
    for (const s of shoots.rows) {
      const attempt = await redeemClaimCode(client, { submitted: code ?? "", shootId: s.id, ip });
      if (attempt.outcome === "success" || attempt.outcome === "already_redeemed") { result = attempt; break; }
      // Keep the most informative non-success outcome to report.
      if (!result || attempt.outcome !== "not_found") result = attempt;
    }

    if (!result || (result.outcome !== "success" && result.outcome !== "already_redeemed")) {
      // Attempts are logged inside this transaction; commit so the rate
      // limit actually counts them.
      await client.query("commit");
      return res.status(400).json({ message: result?.message ?? "That code was not recognised." });
    }

    // Who is this browser? Reuse its guardian if it already has a session
    // (a parent entering a second child's card), otherwise a fresh guardian.
    // Never look a guardian up by anything the request merely asserts.
    const existing = await readParentSession(client, req);
    const guardianId = existing?.guardianId ?? (await createAnonymousGuardian(client));

    if (result.outcome === "success") {
      await completeClaim(client, {
        studioId,
        claimCodeId: result.claimCodeId!,
        childId: result.childId!,
        shootId: result.shootId!,
        guardianId,
        ip,
        consentWordingVersion: "v1.0",
        locale: "en",
      });
    } else {
      // The card was used before (other parent, new phone). Holding the card
      // is the credential, so bind this browser's guardian too — the code
      // itself stays burned, and a revoked or expired code never gets here.
      await client.query(
        `insert into guardian_child (studio_id, guardian_id, child_id, relationship, bound_via, bound_ip)
         values ($1, $2, $3, 'parent', 'claim_code', $4)
         on conflict (guardian_id, child_id) do update set revoked_at = null`,
        [studioId, guardianId, result.childId, ip],
      );
      await client.query(
        `insert into consent_record (studio_id, child_id, guardian_id, shoot_id, scope, wording_version, locale, evidence)
         values ($1, $2, $3, $4, 'service', 'v1.0', 'en', $5) on conflict do nothing`,
        [studioId, result.childId, guardianId, result.shootId, JSON.stringify({ ip, at: new Date().toISOString(), via: "re-entry" })],
      );
    }

    await grantChildToBrowser(client, req, res, existing, guardianId, result.childId!);
    await client.query("commit");
    res.json({ childId: result.childId });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error(err);
    res.status(500).json({ message: "Something went wrong on our end." });
  } finally {
    client.release();
  }
});

// ── Parent gallery ────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND_PAGE = () =>
  page({ title: "Not found", nav: PARENT_NAV, body: `<div class="empty">No such gallery.</div>` });

/**
 * A browser that has not entered this child's card gets the same page as a
 * gallery that does not exist — no hint that the id is real — plus a way in.
 */
const LOCKED_PAGE = () =>
  page({
    title: "Enter your code",
    nav: PARENT_NAV,
    body: `<div class="claim"><h1>Enter your code</h1>
      <p>To see these photographs, enter the code from your child's card on this device.</p>
      <a class="btn" href="/" style="display:inline-block;text-align:center">Enter code</a></div>`,
  });

app.get("/g/:childId", async (req, res) => {
  // A malformed id reached Postgres as a uuid cast and raised, surfacing as a
  // 500. Validate the shape first.
  if (!UUID_RE.test(req.params.childId)) return res.status(404).send(NOT_FOUND_PAGE());
  const session = await readParentSession(pool, req);
  if (!(await sessionCanViewChild(pool, session, req.params.childId))) {
    return res.status(404).send(LOCKED_PAGE());
  }
  await renderGallery(req, res, req.params.childId, session);
});

// Staff preview of any child's gallery: behind the /admin Basic-auth gate,
// read-only, no ordering.
app.get("/admin/preview/:childId", async (req, res) => {
  if (!UUID_RE.test(req.params.childId)) return res.status(404).send(NOT_FOUND_PAGE());
  await renderGallery(req, res, req.params.childId, null);
});

async function renderGallery(req: express.Request, res: express.Response, childId: string, session: ParentSession | null) {
  const isParent = session !== null;

  // Parent reads run as the guardian under the database's row-level policies
  // (asGuardianRls), so even a bug in the check above cannot widen what comes
  // back. Staff preview reads directly.
  const load = async (db: { query: typeof pool.query }) => {
    const child = await db.query(
      `select c.id, c.first_name, c.last_name, c.school_id, c.studio_id, s.display_name, s.name as school_name
         from child c join school s on s.id = c.school_id
        where c.id = $1`,
      [childId],
    );
    if (child.rowCount === 0) return null;
    const images = await db.query(
      `select a.id as asset_id, av.storage_key
         from gallery_item gi
         join asset a on a.id = gi.asset_id
         join asset_variant av on av.asset_id = a.id and av.kind = 'preview'
        where gi.child_id = $1
        order by gi.sort_order`,
      [childId],
    );
    // Real prices, from whatever price list is actually published.
    const priceList = await db.query(
      `select id from price_list where studio_id = $1 and status = 'published' order by effective_from desc limit 1`,
      [child.rows[0].studio_id],
    );
    const products = priceList.rows[0]
      ? await db.query(
          `select p.id, p.name_i18n->>'en' as name, p.kind, pr.amount_cents
             from product p join price pr on pr.product_id = p.id and pr.price_list_id = $1
            where p.studio_id = $2 and p.active = true
            order by pr.amount_cents`,
          [priceList.rows[0].id, child.rows[0].studio_id],
        )
      : { rows: [] as any[] };
    const packages = priceList.rows[0]
      ? await db.query(
          `select pk.id, pk.name_i18n->>'en' as name, pk.description_i18n->>'en' as description, pr.amount_cents
             from package pk join price pr on pr.package_id = pk.id and pr.price_list_id = $1
            where pk.studio_id = $2 and pk.active = true
            order by pr.amount_cents`,
          [priceList.rows[0].id, child.rows[0].studio_id],
        )
      : { rows: [] as any[] };
    const orders = isParent
      ? await db.query(
          `select distinct o.order_number, o.total_cents, o.payment_status, o.placed_at
             from "order" o join order_line ol on ol.order_id = o.id
            where o.guardian_id = $1 and ol.child_id = $2
            order by o.placed_at desc`,
          [session!.guardianId, childId],
        )
      : { rows: [] as any[] };
    return { child, images, products, packages, orders };
  };

  const data = isParent
    ? await asGuardianRls(pool, session!.guardianId, (c) => load(c))
    : await load(pool);
  if (!data) return res.status(404).send(NOT_FOUND_PAGE());
  const { images, products, packages, orders } = data;
  const c = data.child.rows[0];
  const schoolLabel = c.display_name || c.school_name;

  // Class and grade are labels only; read after access is established.
  const label = (await pool.query(
    `select cl.name as class_name, g.name as grade_name
       from enrolment e join class_group cl on cl.id = e.class_group_id
       left join grade g on g.id = cl.grade_id
      where e.child_id = $1 limit 1`,
    [childId],
  )).rows[0] ?? {};
  c.class_name = label.class_name;
  c.grade_name = label.grade_name;

  const yoco = await yocoStatus(pool, c.studio_id);
  const cardPayments = yoco.connected;

  const firstName = c.first_name as string;
  const classLine = [schoolLabel, c.grade_name, c.class_name ? `Class ${c.class_name}` : null].filter(Boolean).join(" · ");

  const grid = images.rows.length
    ? images.rows
        .map(
          (r, i) => `<figure class="frame" data-asset="${r.asset_id}" data-i="${i}">
            <button type="button" class="view" aria-label="View photograph ${i + 1} larger">
              <img src="${publicUrl(r.storage_key)}" alt="Photograph ${i + 1} of ${escapeHtml(firstName)}" loading="lazy">
            </button>
            ${isParent ? `<button type="button" class="pick" aria-pressed="false" aria-label="Choose photograph ${i + 1}">
              <span class="tick">✓</span><span class="picklabel">Choose</span></button>` : ""}
          </figure>`,
        )
        .join("")
    : `<div class="empty">No photographs in this gallery yet — check back soon.</div>`;

  // "Per photo" products are charged once for every chosen photograph; a
  // full digital gallery is one price for all of them. The server applies
  // exactly the same rule when it prices the order.
  const productRow = (p: any) => {
    const once = p.kind === "digital_gallery";
    return `<label class="opt">
      <input type="checkbox" class="prod" value="${p.id}" data-name="${escapeHtml(p.name)}"
             data-cents="${Number(p.amount_cents)}" data-once="${once ? 1 : 0}">
      <span class="optname">${escapeHtml(p.name)}
        <small>${once ? "All of " + escapeHtml(firstName) + "'s photographs, one price" : "Per photograph you choose"}${p.kind?.startsWith("digital") ? " · instant download" : ""}</small></span>
      <span class="money">${formatRands(p.amount_cents)}</span></label>`;
  };
  const groups: Array<[string, (p: any) => boolean]> = [
    ["Prints", (p) => p.kind === "print"],
    ["Digital", (p) => p.kind === "digital_single" || p.kind === "digital_gallery"],
    ["Gifts", (p) => p.kind === "merch"],
  ];
  const productBlocks = groups
    .map(([title, f]) => {
      const rows = products.rows.filter(f);
      return rows.length ? `<div class="optgroup">${title}</div>${rows.map(productRow).join("")}` : "";
    })
    .join("");

  const packageCards = packages.rows
    .map(
      (p) => `<label class="pkg">
        <input type="checkbox" class="pkgchk" value="${p.id}" data-name="${escapeHtml(p.name)}" data-cents="${Number(p.amount_cents)}">
        <span class="pkgname">${escapeHtml(p.name)}</span>
        <span class="pkgprice">${formatRands(p.amount_cents)}</span>
        <span class="pkgdesc">${escapeHtml(p.description ?? "")}</span>
      </label>`,
    )
    .join("");

  const orderRows = orders.rows
    .map(
      (o) => `<a class="orderlink" href="/order/${escapeHtml(o.order_number)}">
        <span class="mono">${escapeHtml(o.order_number)}</span>
        <span class="pill ${o.payment_status === "settled" ? "ok" : ""}">${o.payment_status === "settled" ? "Paid" : "Awaiting payment"}</span>
        <span class="money">${formatRands(o.total_cents)}</span><span aria-hidden="true">→</span></a>`,
    )
    .join("");

  const canOrder = isParent && (products.rows.length > 0 || packages.rows.length > 0) && images.rows.length > 0;

  res.send(
    page({
      title: `${c.first_name} ${c.last_name} — photographs`,
      nav: isParent ? PARENT_NAV : NAV,
      body: `
      ${isParent ? "" : `<div class="flash">Staff preview — this is what the parent sees after entering the card code. Ordering is switched off here.</div>`}
      <section class="hero">
        <p class="eyebrow">${escapeHtml(classLine)}</p>
        <h1>${escapeHtml(firstName)}'s photographs</h1>
        ${canOrder ? `<ol class="steps"><li>Choose your favourite photographs</li><li>Pick a package or prints</li><li>Pay securely — digital copies download straight away</li></ol>` : ""}
      </section>

      ${orderRows ? `<div class="sectlabel"><span>Your orders</span></div><div class="orders">${orderRows}</div>` : ""}

      <div class="sectlabel"><span>${images.rows.length} photograph${images.rows.length === 1 ? "" : "s"}${canOrder ? " — tap to view, “Choose” to select" : ""}</span></div>
      <div class="gallery" id="grid">${grid}</div>

      ${!isParent ? "" : !canOrder
        ? `<div class="note">Ordering opens as soon as the studio has published prices.</div>`
        : `
      <div class="sectlabel" id="orderstart"><span>Packages — best value</span></div>
      ${packageCards ? `<div class="pkgs">${packageCards}</div>` : `<div class="hint">No packages this time — choose individual items below.</div>`}

      <div class="sectlabel"><span>Or choose individually</span></div>
      <div class="opts">${productBlocks}</div>

      <div class="sectlabel"><span>Your order</span></div>
      <div class="summary" id="summary">
        <div id="lines" class="lines"><div class="hint">Choose photographs and at least one package or item.</div></div>
        <div class="totalrow"><span>Total</span><span id="total" class="money">R0</span></div>
        <label class="field">Email for your receipt
          <input type="email" id="email" autocomplete="email" placeholder="you@example.com" required></label>
        <div id="err" class="err" role="alert"></div>
        <button class="btn" id="place" disabled>Choose photographs to start</button>
        <p class="fine">${cardPayments
          ? "You'll pay on Yoco's secure page — card or instant EFT. Prices include VAT."
          : "The studio will contact you to arrange payment. Prices include VAT."}
          Prints are printed after the school's order deadline and delivered to the school.</p>
        <div id="confirm" class="confirm" hidden><b>Order received.</b> <span id="ordNum"></span></div>
      </div>

      <div class="basket" id="basket" hidden>
        <span id="bcount">0 photos</span><span id="btotal" class="money">R0</span>
        <a href="#summary" class="btn small">Review order</a>
      </div>`}

      <dialog class="lightbox" id="lb" aria-label="Photograph">
        <img id="lbimg" alt="">
        <div class="lbbar">
          <button type="button" id="lbprev" aria-label="Previous">←</button>
          ${isParent && canOrder ? `<button type="button" id="lbpick" class="btn small">Choose this photo</button>` : `<span></span>`}
          <button type="button" id="lbnext" aria-label="Next">→</button>
          <button type="button" id="lbclose" class="lbclose" aria-label="Close">✕</button>
        </div>
      </dialog>

      <script>
      ${FORMAT_RANDS_JS}
      (function(){
        const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
        const frames=$$('.frame'), picked=new Set();
        const lb=$('#lb'); let cur=0;

        function show(i){ cur=(i+frames.length)%frames.length;
          const f=frames[cur]; $('#lbimg').src=f.querySelector('img').src;
          const b=$('#lbpick'); if(b){ const on=picked.has(f.dataset.asset);
            b.textContent=on?'✓ Chosen — tap to remove':'Choose this photo'; b.classList.toggle('on',on); } }
        frames.forEach((f,i)=>{
          f.querySelector('.view').onclick=()=>{ show(i); lb.showModal(); };
          const p=f.querySelector('.pick'); if(p) p.onclick=()=>toggle(f);
        });
        $('#lbprev').onclick=()=>show(cur-1); $('#lbnext').onclick=()=>show(cur+1);
        $('#lbclose').onclick=()=>lb.close();
        lb.addEventListener('click',e=>{ if(e.target===lb) lb.close(); });
        document.addEventListener('keydown',e=>{ if(!lb.open) return;
          if(e.key==='ArrowLeft') show(cur-1); if(e.key==='ArrowRight') show(cur+1); });
        if($('#lbpick')) $('#lbpick').onclick=()=>{ toggle(frames[cur]); show(cur); };

        function toggle(f){ const id=f.dataset.asset;
          picked.has(id)?picked.delete(id):picked.add(id);
          const on=picked.has(id); f.classList.toggle('picked',on);
          const p=f.querySelector('.pick'); if(p){ p.setAttribute('aria-pressed',on); p.querySelector('.picklabel').textContent=on?'Chosen':'Choose'; }
          update(); }

        const place=$('#place'); if(!place) return;
        function update(){
          const n=picked.size, lines=[]; let total=0;
          $$('.pkgchk:checked').forEach(el=>{ const c=+el.dataset.cents; total+=c;
            lines.push([el.dataset.name+' package', c]); });
          $$('.prod:checked').forEach(el=>{ const c=+el.dataset.cents;
            if(el.dataset.once==='1'){ total+=c; lines.push([el.dataset.name,c]); }
            else { total+=c*n; lines.push([el.dataset.name+' × '+n+' photo'+(n===1?'':'s'), c*n]); } });
          $('#lines').innerHTML = lines.length
            ? lines.map(l=>'<div class="line"><span>'+l[0].replace(/[&<>]/g,'')+'</span><span class="money">'+formatRands(l[1])+'</span></div>').join('')
            : '<div class="hint">Choose photographs and at least one package or item.</div>';
          $('#total').textContent=formatRands(total);
          const ready=n>0 && lines.length>0;
          place.disabled=!ready;
          place.textContent= ready ? (${cardPayments ? "'Pay '" : "'Place order — '"}+formatRands(total))
                           : n===0 ? 'Choose photographs to start' : 'Choose a package or item';
          const b=$('#basket'); b.hidden = n===0 && lines.length===0;
          $('#bcount').textContent = n+' photo'+(n===1?'':'s')+' chosen';
          $('#btotal').textContent = formatRands(total);
        }
        $$('.prod,.pkgchk').forEach(el=>el.onchange=update);

        place.onclick=async()=>{
          const email=$('#email').value.trim(), err=$('#err');
          if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){ err.textContent='Please enter the email address for your receipt.'; $('#email').focus(); return; }
          err.textContent=''; place.disabled=true; place.textContent='One moment…';
          try{
            const r=await fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({ childId:'${c.id}', email, assetIds:[...picked],
                productIds:$$('.prod:checked').map(e=>e.value), packageIds:$$('.pkgchk:checked').map(e=>e.value) })});
            const data=await r.json();
            if(!r.ok){ err.textContent=data.message||'Something went wrong — please try again.'; update(); return; }
            if(data.redirectUrl){ place.textContent='Taking you to secure payment…'; location.href=data.redirectUrl; return; }
            if(data.orderPage){ location.href=data.orderPage; return; }
            $('#ordNum').textContent='Order number '+data.orderNumber; $('#confirm').hidden=false; place.hidden=true;
          }catch(e){ err.textContent='No connection — please try again.'; update(); }
        };
        update();
      })();
      </script>`,
    }),
  );
}

// ── Place an order: real order + order_line rows, real price snapshots ──────
app.post("/api/order", async (req, res) => {
  const client = await pool.connect();
  try {
    const { childId, email, assetIds, productIds, packageIds } = req.body as {
      childId: string; email: string; assetIds: string[];
      productIds?: string[]; packageIds?: string[];
    };
    const wantProducts = productIds ?? [];
    const wantPackages = packageIds ?? [];
    if (!childId || !email || !email.includes("@")) {
      return res.status(400).json({ message: "A valid email address is required." });
    }
    if (!assetIds?.length || (wantProducts.length === 0 && wantPackages.length === 0)) {
      return res.status(400).json({ message: "Select at least one photograph and a package or product." });
    }
    if (typeof childId !== "string" || !UUID_RE.test(childId)) {
      return res.status(404).json({ message: "Unknown child." });
    }
    // Only a browser that entered this child's card may order for them, and
    // the order belongs to THAT browser's guardian.
    const session = await readParentSession(client, req);
    if (!(await sessionCanViewChild(client, session, childId))) {
      return res.status(403).json({ message: "Enter your child's code on this device first." });
    }
    const guardianId = session!.guardianId;

    const child = await client.query(
      `select studio_id, school_id from child where id = $1`, [childId],
    );
    if (child.rowCount === 0) return res.status(404).json({ message: "Unknown child." });
    const { studio_id: studioId, school_id: schoolId } = child.rows[0];

    // Every asset requested must actually belong to THIS child's gallery.
    // Without this check, a crafted request could attach any asset id in the
    // system — another child's, another school's — to an order placed under
    // this child, mixing data across the isolation boundary the rest of the
    // system spends so much effort enforcing.
    const ownedAssets = await client.query(
      `select asset_id from gallery_item where child_id = $1 and asset_id = any($2::uuid[])`,
      [childId, assetIds],
    );
    if (ownedAssets.rowCount !== assetIds.length) {
      return res.status(400).json({ message: "One or more selected photographs are not valid for this order." });
    }

    // Real prices, looked up now, from the studio's own published list — never
    // the amount the browser happened to send. A client can compute a total to
    // *display*, but it cannot set what is actually charged; that price comes
    // from the same table src/server's admin Settings page edits, at the
    // moment of ordering, not at the moment the page was rendered.
    const priceList = await client.query(
      `select id from price_list where studio_id = $1 and status = 'published'
         order by effective_from desc limit 1`,
      [studioId],
    );
    if (priceList.rowCount === 0) {
      return res.status(400).json({ message: "No prices are currently published for this school." });
    }
    const priced = wantProducts.length
      ? await client.query(
          `select pr.product_id, pr.amount_cents, p.name_i18n->>'en' as name, p.kind
             from price pr join product p on p.id = pr.product_id
            where pr.price_list_id = $1 and pr.product_id = any($2::uuid[]) and p.active = true`,
          [priceList.rows[0].id, wantProducts],
        )
      : { rows: [], rowCount: 0 };
    if (priced.rowCount !== wantProducts.length) {
      return res.status(400).json({ message: "One or more selected products are no longer available." });
    }

    // Packages are priced server-side too, and are charged ONCE per order
    // rather than per photograph — a bundle is a bundle.
    const pricedPackages = wantPackages.length
      ? await client.query(
          `select pr.package_id, pr.amount_cents, pk.name_i18n->>'en' as name,
                  exists(select 1 from package_item pi join product p2 on p2.id = pi.product_id
                          where pi.package_id = pk.id
                            and p2.kind in ('digital_single','digital_gallery')) as has_digital,
                  pk.description_i18n->>'en' as description
             from price pr join package pk on pk.id = pr.package_id
            where pr.price_list_id = $1 and pr.package_id = any($2::uuid[]) and pk.active = true`,
          [priceList.rows[0].id, wantPackages],
        )
      : { rows: [], rowCount: 0 };
    if (pricedPackages.rowCount !== wantPackages.length) {
      return res.status(400).json({ message: "One or more selected packages are no longer available." });
    }

    const shoot = await client.query(
      `select id from shoot where studio_id = $1 and school_id = $2 order by created_at desc limit 1`,
      [studioId, schoolId],
    );
    const shootId = shoot.rows[0]?.id;

    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true)");

    // The email is a receipt address only. The guardian was decided by the
    // session above; looking one up by typed email let anyone attach orders
    // and downloads to another parent's account. If this guardian still has
    // a placeholder address, adopt this one — unless another account has it.
    await client.query(
      `update guardian set email = $2
        where id = $1 and email like '%@claim.invalid'
          and not exists (select 1 from guardian g2 where g2.email = $2)`,
      [guardianId, email],
    );

    let subtotal = 0;
    const lines: Array<{
      kind: "product" | "package"; name: string; unitCents: number; qty: number;
      assetId: string | null; isDigital: boolean; allAssets?: string[];
    }> = [];

    // Per-photo products: one line per photograph per product.
    // Number() on every amount is load-bearing, not defensive noise:
    // node-postgres returns bigint columns as STRINGS (to avoid silently
    // losing precision beyond 2^53), so `subtotal += p.amount_cents` silently
    // performs string concatenation — R145 + R485 became R14,500,485.00.
    // Caught by asserting an expected total rather than eyeballing the response.
    // A full digital gallery is one price for ALL of this child's photos, not
    // one charge per chosen photo (it was: 4 photos + gallery = 4 × R320).
    // Its line carries every gallery asset so payment releases all of them.
    const galleryProducts = priced.rows.filter((p) => p.kind === "digital_gallery");
    const perPhotoProducts = priced.rows.filter((p) => p.kind !== "digital_gallery");
    if (galleryProducts.length) {
      const all = await client.query(
        `select asset_id from gallery_item where child_id = $1 order by sort_order`, [childId],
      );
      for (const p of galleryProducts) {
        const cents = Number(p.amount_cents);
        lines.push({ kind: "product", name: p.name, unitCents: cents, qty: 1, assetId: null, isDigital: true,
                     allAssets: all.rows.map((r) => r.asset_id as string) });
        subtotal += cents;
      }
    }
    for (const assetId of assetIds) {
      for (const p of perPhotoProducts) {
        const cents = Number(p.amount_cents);
        lines.push({
          kind: "product", name: p.name, unitCents: cents, qty: 1, assetId,
          // The product's real `kind` column, not a substring match on its
          // name. Name-matching broke the moment a product was called
          // something sensible that happened not to contain the word.
          isDigital: p.kind === "digital_single" || p.kind === "digital_gallery",
        });
        subtotal += cents;
      }
    }
    // Packages: charged once, and carry the whole photo selection rather than
    // being duplicated per photograph.
    for (const p of pricedPackages.rows) {
      const cents = Number(p.amount_cents);
      lines.push({
        kind: "package", name: p.name, unitCents: cents, qty: 1, assetId: null,
        // A package counts as digital if it actually contains a digital item.
        // The seeded packages have no package_item rows yet (their contents
        // are described in prose), so fall back to the description text —
        // imperfect, and flagged: once package contents are editable in admin,
        // has_digital becomes authoritative on its own.
        isDigital: p.has_digital || /digital/i.test(p.description ?? ""),
      });
      subtotal += cents;
    }

    const orderNumber = generateOrderNumber("WJ");
    const order = await client.query(
      `insert into "order" (studio_id, school_id, shoot_id, guardian_id, order_number,
                            subtotal_cents, total_cents, payment_status, digital_status, contact_email)
       values ($1,$2,$3,$4,$5,$6,$6,'pending',$7,$8) returning id`,
      [studioId, schoolId, shootId, guardianId, orderNumber, subtotal,
       lines.some((l) => l.isDigital) ? "pending" : "none", email],
    );
    const orderId = order.rows[0].id;

    let lineNo = 1;
    for (const l of lines) {
      await client.query(
        `insert into order_line (studio_id, order_id, child_id, line_no, kind, quantity,
                                 unit_cents, line_total_cents, vat_rate_bps, snapshot, fulfilment_kind)
         values ($1,$2,$3,$4,$10,$5,$6,$7,1500,$8,$9)`,
        [
          studioId, orderId, childId, lineNo++, l.qty, l.unitCents, l.unitCents * l.qty,
          // The snapshot is what makes an old order reconstructible even after
          // the catalogue changes (§11.1) — so it records the whole selection.
          JSON.stringify({ name: l.name, assetId: l.assetId,
                           assetIds: l.allAssets ?? (l.kind === "package" ? assetIds : undefined) }),
          l.isDigital ? "digital" : "physical",
          l.kind,
        ],
      );
    }

    await client.query("commit");

    // Card payment, if Yoco is connected. A Yoco outage must not lose the
    // order: it is already committed, and the order page offers "Pay now".
    let redirectUrl: string | null = null;
    try {
      redirectUrl = await startCheckout(pool, orderId, `${req.protocol}://${req.get("host")}`);
    } catch (err) {
      console.error({ event: "yoco.checkout.failed", orderNumber, err: (err as Error).message });
    }
    res.json({ orderNumber, total: subtotal, redirectUrl, orderPage: `/order/${orderNumber}` });
  } catch (err) {
    await client.query("rollback");
    console.error(err);
    res.status(500).json({ message: "Something went wrong placing the order." });
  } finally {
    client.release();
  }
});

// ── Parent order page: status, pay, downloads ──────────────────────────────
const ORDER_NO_RE = /^[0-9A-Z-]{4,40}$/;

async function loadOwnOrder(req: express.Request, orderNumber: string) {
  if (!ORDER_NO_RE.test(orderNumber)) return null;
  const session = await readParentSession(pool, req);
  if (!session) return null;
  const o = (await pool.query(
    `select o.id, o.order_number, o.total_cents, o.payment_status, o.digital_status, o.studio_id,
            o.placed_at, o.contact_email,
            array(select distinct ol.child_id from order_line ol where ol.order_id = o.id) as child_ids
       from "order" o where o.order_number = $1 and o.guardian_id = $2`,
    [orderNumber, session.guardianId],
  )).rows[0];
  if (!o) return null;
  // Belonging to the guardian is not enough: this browser must also hold the
  // card for every child on the order.
  for (const cid of o.child_ids as string[]) {
    if (!(await sessionCanViewChild(pool, session, cid))) return null;
  }
  return { session, o };
}

app.get("/order/:orderNumber", async (req, res) => {
  const own = await loadOwnOrder(req, req.params.orderNumber);
  if (!own) return res.status(404).send(LOCKED_PAGE());
  const { session, o } = own;

  const data = await asGuardianRls(pool, session.guardianId, async (c) => {
    const lines = await c.query(
      `select line_no, kind, line_total_cents, fulfilment_kind, snapshot->>'name' as name
         from order_line where order_id = $1 order by line_no`,
      [o.id],
    );
    const grants = await c.query(
      `select dg.id, dg.downloads, dg.max_downloads, dg.expires_at, av.storage_key as thumb
         from download_grant dg
         left join asset_variant av on av.asset_id = dg.asset_id and av.kind = 'thumb'
        where dg.order_id = $1 and dg.guardian_id = $2 and dg.revoked_at is null
        order by dg.created_at`,
      [o.id, session.guardianId],
    );
    return { lines: lines.rows, grants: grants.rows };
  });

  const yoco = await yocoStatus(pool, o.studio_id);
  const paid = o.payment_status === "settled";
  const q = req.query as Record<string, string>;
  const polls = Number(q.poll ?? 0);
  const awaitingWebhook = !paid && (q.returned === "1" || (q.poll && polls < 20)) && o.payment_status === "initiated";
  const canPay = !paid && yoco.connected && Number(o.total_cents) >= 200;

  let status: string;
  if (paid) status = `<b>Paid — thank you.</b>`;
  else if (awaitingWebhook) status = `<b>Confirming your payment…</b> This page updates by itself in a moment.`;
  else if (q.cancelled === "1") status = `Payment was cancelled. Your order is saved — you can pay whenever you're ready.`;
  else if (q.failed === "1" || o.payment_status === "failed") status = `The payment didn't go through. Nothing was charged — please try again.`;
  else if (canPay) status = `Awaiting payment.`;
  else status = `Awaiting payment. The studio will be in touch to arrange it.`;

  const lineRows = data.lines
    .map((l: any) => `<div class="line"><span>${escapeHtml(l.name ?? l.kind)}
        <small class="kind">${l.kind === "package" ? "package" : l.fulfilment_kind === "digital" ? "digital download" : "printed &amp; delivered to school"}</small></span>
        <span class="money">${formatRands(l.line_total_cents)}</span></div>`)
    .join("");

  const downloads = data.grants.length
    ? `<div class="sectlabel"><span>Your digital photographs</span></div>
       <div class="gallery">${data.grants
         .map((g: any, i: number) => `<figure class="frame">
             ${g.thumb ? `<img src="${publicUrl(g.thumb)}" alt="Photograph ${i + 1}">` : ""}
             <a class="pick" href="/download/${g.id}" download>Download</a></figure>`)
         .join("")}</div>
       <div class="note">Full-resolution files without watermark. Each link works on this device for a year.</div>`
    : paid && o.digital_status === "none"
    ? `<div class="note">Your prints will be printed after the school's order deadline and delivered to the school.</div>`
    : "";

  res.send(page({
    title: `Order ${o.order_number}`,
    nav: PARENT_NAV,
    body: `
    ${awaitingWebhook ? `<meta http-equiv="refresh" content="3;url=/order/${o.order_number}?poll=${polls + 1}">` : ""}
    <section class="hero">
      <p class="eyebrow">Order ${escapeHtml(o.order_number)}${o.contact_email ? " · receipt to " + escapeHtml(o.contact_email) : ""}</p>
      <h1>${paid ? "Thank you" : "Your order"}</h1>
    </section>
    <div class="summary">
      <p class="status ${paid ? "ok" : ""}">${status}</p>
      <div class="lines">${lineRows}</div>
      <div class="totalrow"><span>Total</span><span class="money">${formatRands(o.total_cents)}</span></div>
      ${canPay && !awaitingWebhook
        ? `<form method="post" action="/order/${o.order_number}/pay"><button class="btn" type="submit">Pay ${formatRands(o.total_cents)} securely</button></form>
           <p class="fine">Card or instant EFT on Yoco's secure page. Prices include VAT.</p>`
        : ""}
    </div>
    ${downloads}
    <p style="margin-top:16px"><a href="/g/${(o.child_ids as string[])[0]}" style="text-decoration:underline">← Back to the photographs</a></p>`,
  }));
});

app.post("/order/:orderNumber/pay", async (req, res) => {
  const own = await loadOwnOrder(req, req.params.orderNumber);
  if (!own) return res.status(404).send(LOCKED_PAGE());
  try {
    const url = await startCheckout(pool, own.o.id, `${req.protocol}://${req.get("host")}`);
    if (url) return res.redirect(303, url);
  } catch (err) {
    console.error({ event: "yoco.checkout.failed", orderNumber: own.o.order_number, err: (err as Error).message });
  }
  res.redirect(303, `/order/${own.o.order_number}?failed=1`);
});

// Full-resolution original, only to the guardian the grant was issued to, and
// only from a browser holding that child's card. This is the ONLY route that
// ever reads an original off the volume.
app.get("/download/:grantId", async (req, res) => {
  if (!UUID_RE.test(req.params.grantId)) return res.status(404).send(NOT_FOUND_PAGE());
  const session = await readParentSession(pool, req);
  if (!session) return res.status(404).send(LOCKED_PAGE());
  const g = (await pool.query(
    `update download_grant dg set downloads = downloads + 1
       from asset a, "order" o
      where dg.id = $1 and dg.guardian_id = $2 and dg.revoked_at is null
        and dg.expires_at > now() and dg.downloads < dg.max_downloads
        and a.id = dg.asset_id and o.id = dg.order_id and o.payment_status = 'settled'
      returning a.storage_key, a.original_name, dg.order_id`,
    [req.params.grantId, session.guardianId],
  )).rows[0];
  if (!g) return res.status(404).send(page({ title: "Download unavailable", nav: PARENT_NAV,
    body: `<div class="empty">This download is not available. It may have expired or reached its download limit — contact the studio.</div>` }));
  const childOk = (await pool.query(
    `select array(select distinct child_id from order_line where order_id = $1) as ids`, [g.order_id],
  )).rows[0].ids as string[];
  for (const cid of childOk) {
    if (!(await sessionCanViewChild(pool, session, cid))) return res.status(404).send(LOCKED_PAGE());
  }
  const bytes = await getObject(g.storage_key);
  const name = String(g.original_name ?? "photograph.jpg").replace(/[^\w.\- ]/g, "_");
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(bytes);
});

// ============================================================================
// ADMIN — multi-school, with everything editable
// ============================================================================

function paymentsPanel(y: Awaited<ReturnType<typeof yocoStatus>>): string {
  const input = `<input name="secret_key" type="password" autocomplete="off" placeholder="sk_live_… or sk_test_…"
       style="flex:1;min-width:240px;padding:9px;border:1px solid var(--rule);border-radius:2px">`;
  if (!y.connected) {
    return `<div class="note">Not connected — parents can order, and you confirm payment with "Mark paid".
        To take card payments, paste your <b>secret key</b> from the Yoco app
        (Yoco Connect → Checkout API → How to connect). Everything else is set up automatically.
        ${y.lastError ? `<br><span style="color:var(--chinagraph)">${escapeHtml(y.lastError)}</span>` : ""}</div>
      <form method="post" action="/admin/payments" style="display:flex;gap:6px;flex-wrap:wrap;max-width:560px">
        ${input}<button type="submit" class="btn" style="width:auto;padding:9px 16px">Connect Yoco</button></form>`;
  }
  const mode = y.mode === "live" ? `<span class="pill ok">Live</span>` : `<span class="pill">Test mode</span>`;
  const hook = y.webhookReady
    ? `<span class="pill ok">Automatic confirmation on</span>`
    : `<span class="pill">Automatic confirmation not set up</span>`;
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${mode} ${hook}</div>
    ${y.mode === "test" ? `<div class="note">Test mode: no real money moves. Switch to your live key once Yoco has verified this website.</div>` : ""}
    ${y.lastError && !y.webhookReady ? `<div class="note" style="color:var(--chinagraph)">${escapeHtml(y.lastError)}</div>` : ""}
    ${y.source === "env"
      ? `<div class="note">The key is set on the server (YOCO_SECRET_KEY), so it can't be changed here.</div>`
      : `<form method="post" action="/admin/payments" style="display:flex;gap:6px;flex-wrap:wrap;max-width:560px">
           ${input}<button type="submit" class="btn" style="width:auto;padding:9px 16px">Replace key</button></form>
         <form method="post" action="/admin/payments" style="margin-top:6px"
               onsubmit="return confirm('Disconnect Yoco? Parents will no longer be able to pay by card.')">
           <input type="hidden" name="secret_key" value=""><button type="submit" class="pill">Disconnect</button></form>`}`;
}

app.post("/admin/payments", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();
  if (process.env.YOCO_SECRET_KEY) return res.redirect(303, "/admin");
  await saveYocoKey(pool, studioId, String(req.body.secret_key ?? ""));
  res.redirect(303, "/admin");
});

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

  const notice = req.query.saved
    ? { ok: true, text: String(req.query.saved) }
    : req.query.error
    ? { ok: false, text: String(req.query.error) }
    : null;
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

  // Search across children by name. Uses app.immutable_unaccent so that a
  // parent or staff member typing "Zane" finds "Zané" — the exact case §13
  // built the unaccent index for. Also matches on the full name, so "Botha"
  // and "Noah Botha" both work.
  const q = ((req.query.q as string) || "").trim();
  const children = q
    ? await pool.query(
        `select c.id, c.first_name, c.last_name,
                (select count(*) from gallery_item gi where gi.child_id = c.id) as photo_count,
                exists(select 1 from claim_code cc where cc.child_id = c.id and cc.redeemed_at is not null) as claimed
           from child c
          where c.school_id = $1
            and app.immutable_unaccent(c.first_name || ' ' || c.last_name)
                ilike '%' || app.immutable_unaccent($2) || '%'
          order by c.last_name, c.first_name`,
        [selected.id, q],
      )
    : await pool.query(
        `select c.id, c.first_name, c.last_name,
                (select count(*) from gallery_item gi where gi.child_id = c.id) as photo_count,
                exists(select 1 from claim_code cc where cc.child_id = c.id and cc.redeemed_at is not null) as claimed
           from child c where c.school_id = $1 order by c.last_name, c.first_name`,
        [selected.id],
      );

  const products = await pool.query(
    `select id, sku, name_i18n->>'en' as name, kind, active from product where studio_id = $1
      order by active desc, name_i18n->>'en'`,
    [studioId],
  );
  const packages = await pool.query(
    `select pk.id, pk.name_i18n->>'en' as name, pk.description_i18n->>'en' as description, pk.active,
            (select pr.amount_cents from price pr join price_list pl on pl.id = pr.price_list_id
              where pr.package_id = pk.id and pl.status = 'published'
              order by pl.effective_from desc limit 1) as amount_cents,
            coalesce((select jsonb_object_agg(pi.product_id, pi.quantity) from package_item pi
                       where pi.package_id = pk.id), '{}'::jsonb) as items
       from package pk where pk.studio_id = $1
      order by pk.active desc, pk.sort_order, pk.name_i18n->>'en'`,
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

  const yoco = await yocoStatus(pool, studioId);
  const orders = await pool.query(
    `select o.id, o.order_number, o.total_cents, o.payment_status, o.digital_status,
            o.fulfilment_status, coalesce(o.contact_email, g.email) as email
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

      <div class="sectlabel"><span>Card payments (Yoco)</span></div>
      ${paymentsPanel(yoco)}

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

      ${notice ? `<div class="flash ${notice.ok ? "ok" : ""}">${escapeHtml(notice.text)}</div>` : ""}
      <div class="sectlabel" id="products"><span>Products &amp; prices</span></div>
      <p class="hint">Prices are in Rands, VAT included — type <b>145</b> or <b>145,50</b>. Per-photo items are
        charged once for every photograph the parent picks.</p>
      ${products.rows
        .map((p) => `<form id="p-${p.id}" method="post" action="/admin/product/${p.id}"></form>`)
        .join("")}
      <div class="tablewrap"><table class="edit"><thead><tr><th>Product</th><th>Type</th><th>Price</th><th>On sale</th><th></th></tr></thead><tbody>
        ${products.rows
          .map(
            (p) => `<tr class="${p.active ? "" : "off"}">
              <td><input form="p-${p.id}" name="name" value="${escapeHtml(p.name)}" required aria-label="Product name">
                  <div class="sku">${escapeHtml(p.sku)}</div></td>
              <td><span class="pill">${escapeHtml(KIND_LABEL[p.kind] ?? p.kind)}</span></td>
              <td><label class="rands"><span>R</span><input form="p-${p.id}" name="price" inputmode="decimal"
                    value="${randsInputValue(priceByProduct.get(p.id))}" required aria-label="Price in Rands"></label></td>
              <td><input form="p-${p.id}" type="checkbox" name="active" ${p.active ? "checked" : ""} aria-label="On sale"></td>
              <td><button form="p-${p.id}" type="submit" class="pill">Save</button></td>
            </tr>`,
          )
          .join("")}
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

      <div class="sectlabel" id="packages"><span>Packages</span></div>
      <p class="hint">A package is one price for a bundle. Tick what's in it — digital items are released to
        the parent the moment they pay. Packages that are off are hidden from parents.</p>
      ${packages.rows.length ? packages.rows.map((pk) => packageEditor(pk, products.rows)).join("") : `<div class="empty">No packages yet.</div>`}
      <details class="newpkg"><summary class="btn small">+ New package</summary>
        <form method="post" action="/admin/package" class="pkgform">
          <label>Name<input name="name" placeholder="e.g. Platinum" required></label>
          <label>Price<span class="rands"><span>R</span><input name="price" inputmode="decimal" placeholder="1 200" required></span></label>
          <label class="wide">What parents read<input name="description" placeholder="e.g. Everything in Gold plus an A3 print"></label>
          <button type="submit" class="btn small">Create package</button>
        </form>
      </details>

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
                <td class="mono">${formatRands(o.total_cents)}</td>
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
          <div class="note">Card payments through Yoco settle automatically and release digital
            photographs to the parent straight away. Use "Mark paid" only for cash or EFT — it does
            exactly the same thing.</div>`
      }

      <div class="sectlabel"><span>Children</span></div>
      <form method="get" action="/admin" style="display:flex;gap:6px;margin-bottom:10px;max-width:420px">
        <input type="hidden" name="school" value="${selected.id}">
        <input name="q" value="${escapeHtml(q)}" placeholder="Search by name…"
               style="flex:1;padding:9px;border:1px solid var(--rule);border-radius:2px">
        <button type="submit" class="btn" style="width:auto;padding:9px 16px">Search</button>
        ${q ? `<a href="/admin?school=${selected.id}" class="navlink" style="align-self:center">Clear</a>` : ""}
      </form>
      ${q ? `<div class="mono" style="font-size:11px;color:var(--silver);margin-bottom:8px">
              ${children.rowCount} result(s) for "${escapeHtml(q)}"</div>` : ""}
      ${
        children.rowCount === 0
          ? q
            ? `<div class="empty">No children match "${escapeHtml(q)}".</div>`
            : `<div class="empty">No children at this school yet.</div>`
          : `<table><thead><tr><th>Name</th><th>Photographs</th><th>Gallery</th><th>Claim cards</th><th>Claimed</th></tr></thead><tbody>
          ${children.rows
            .map(
              (r) => `<tr>
                <td>${escapeHtml(r.first_name)} ${escapeHtml(r.last_name)}</td>
                <td>${r.photo_count}</td>
                <td><a href="/admin/preview/${r.id}" style="text-decoration:underline">Preview gallery →</a></td>
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
  if (!UUID_RE.test(req.params.id)) return res.status(404).send("Unknown order.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true)");
    // Same path as a Yoco webhook: settle, then grant digital downloads.
    // The digital-release gate (0013) still refuses delivery while unpaid.
    await settleOrder(client, req.params.id);
    const school = await client.query(`select school_id from "order" where id = $1`, [req.params.id]);
    await client.query("commit");
    res.redirect(`/admin?school=${school.rows[0].school_id}`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error(err);
    res.status(500).send("Error marking order paid: " + escapeHtml((err as Error).message));
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

const KIND_LABEL: Record<string, string> = {
  print: "Print",
  merch: "Gift",
  digital_single: "Digital",
  digital_gallery: "Digital gallery",
};

function packageEditor(pk: any, products: any[]): string {
  const items = (pk.items ?? {}) as Record<string, number>;
  const rows = products
    .filter((p) => p.active || items[p.id])
    .map(
      (p) => `<label class="pkgitem"><input type="number" name="qty_${p.id}" min="0" max="99"
          value="${items[p.id] ?? 0}" inputmode="numeric" aria-label="Quantity of ${escapeHtml(p.name)}">
        <span>${escapeHtml(p.name)}</span></label>`,
    )
    .join("");
  return `<form method="post" action="/admin/package/${pk.id}" class="pkgcard ${pk.active ? "" : "off"}">
    <div class="pkgform">
      <label>Name<input name="name" value="${escapeHtml(pk.name)}" required></label>
      <label>Price<span class="rands"><span>R</span><input name="price" inputmode="decimal"
        value="${randsInputValue(pk.amount_cents)}" required></span></label>
      <label class="wide">What parents read<input name="description" value="${escapeHtml(pk.description ?? "")}"
        placeholder="Left empty, this is written from the contents below"></label>
    </div>
    <div class="pkglabel">Contents <span>— how many of each</span></div>
    <div class="pkgitems">${rows}</div>
    <div class="pkgfoot">
      <label class="toggle"><input type="checkbox" name="active" ${pk.active ? "checked" : ""}> Offered to parents</label>
      <button type="submit" class="btn small">Save package</button>
    </div>
  </form>`;
}

/** Back to the admin section the form came from, with a message. */
function backTo(res: express.Response, anchor: string, msg: { saved?: string; error?: string }) {
  const q = msg.error ? `error=${encodeURIComponent(msg.error)}` : `saved=${encodeURIComponent(msg.saved ?? "Saved.")}`;
  res.redirect(303, `/admin?${q}#${anchor}`);
}

const BAD_PRICE = "That price wasn't understood. Type it in Rands, like 145 or 145,50.";

app.post("/admin/product", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();
  const name = String(req.body.name ?? "").trim();
  const kind = String(req.body.kind ?? "print");
  const cents = parseRands(req.body.price);
  if (!name) return backTo(res, "products", { error: "Give the product a name." });
  if (!KIND_LABEL[kind]) return backTo(res, "products", { error: "Unknown product type." });
  if (cents === null) return backTo(res, "products", { error: BAD_PRICE });

  // The SKU is an internal reference nobody should have to invent; derive a
  // unique one from the name.
  const base = name.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "PRODUCT";
  let sku = base;
  for (let i = 2; (await pool.query(`select 1 from product where studio_id = $1 and sku = $2`, [studioId, sku])).rowCount; i++) {
    sku = `${base}-${i}`;
  }
  const p = await pool.query(
    `insert into product (studio_id, sku, name_i18n, kind, active)
     values ($1, $2, jsonb_build_object('en', $3::text), $4, true) returning id`,
    [studioId, sku, name, kind],
  );
  await setPrice(studioId, { productId: p.rows[0].id }, cents);
  backTo(res, "products", { saved: `${name} added at ${formatRands(cents)}.` });
});

app.post("/admin/product/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return backTo(res, "products", { error: "Unknown product." });
  const { studioId } = await ensureStudioAndStaff();
  const name = String(req.body.name ?? "").trim();
  const cents = parseRands(req.body.price);
  if (!name) return backTo(res, "products", { error: "A product needs a name." });
  if (cents === null) return backTo(res, "products", { error: BAD_PRICE });
  await pool.query(
    `update product set name_i18n = jsonb_build_object('en', $1::text), active = $2 where id = $3 and studio_id = $4`,
    [name, req.body.active === "on", req.params.id, studioId],
  );
  await setPrice(studioId, { productId: req.params.id }, cents);
  backTo(res, "products", { saved: `${name} saved — ${formatRands(cents)}${req.body.active === "on" ? "" : ", not on sale"}.` });
});

/**
 * Set the current published price of a product or package.
 *
 * Updates the published list in place rather than versioning a new list per
 * edit. Safe for orders already placed: every order line stores its own
 * unit_cents and name snapshot at the moment of ordering, so an edit here
 * never changes what an existing order cost.
 */
async function setPrice(studioId: string, target: { productId: string } | { packageId: string }, amountCents: number) {
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
  const col = "productId" in target ? "product_id" : "package_id";
  const id = "productId" in target ? target.productId : target.packageId;
  const upd = await pool.query(
    `update price set amount_cents = $1 where price_list_id = $2 and ${col} = $3`,
    [amountCents, priceListId, id],
  );
  if (upd.rowCount === 0) {
    await pool.query(
      `insert into price (studio_id, price_list_id, ${col}, amount_cents) values ($1, $2, $3, $4)`,
      [studioId, priceListId, id, amountCents],
    );
  }
}

/** Plain-English contents, used when Wiaan leaves the description empty. */
async function describeContents(packageId: string): Promise<string> {
  const r = await pool.query(
    `select pi.quantity, p.name_i18n->>'en' as name from package_item pi join product p on p.id = pi.product_id
      where pi.package_id = $1 order by pi.sort_order`,
    [packageId],
  );
  return r.rows.map((x) => (x.quantity > 1 ? `${x.quantity} × ${x.name}` : x.name)).join(", ");
}

async function savePackageContents(studioId: string, packageId: string, body: Record<string, unknown>) {
  const products = await pool.query(`select id from product where studio_id = $1`, [studioId]);
  await pool.query(`delete from package_item where package_id = $1`, [packageId]);
  let order = 0;
  for (const p of products.rows) {
    const raw = body[`qty_${p.id}`];
    const qty = Math.min(99, Math.max(0, Math.floor(Number(raw ?? 0)) || 0));
    if (qty > 0) {
      await pool.query(
        `insert into package_item (studio_id, package_id, product_id, quantity, sort_order) values ($1, $2, $3, $4, $5)`,
        [studioId, packageId, p.id, qty, order++],
      );
    }
  }
}

app.post("/admin/package", async (req, res) => {
  const { studioId } = await ensureStudioAndStaff();
  const name = String(req.body.name ?? "").trim();
  const cents = parseRands(req.body.price);
  if (!name) return backTo(res, "packages", { error: "Give the package a name." });
  if (cents === null) return backTo(res, "packages", { error: BAD_PRICE });
  const r = await pool.query(
    `insert into package (studio_id, name_i18n, description_i18n, active, sort_order)
     values ($1, jsonb_build_object('en', $2::text), jsonb_build_object('en', $3::text), false,
             coalesce((select max(sort_order) + 1 from package where studio_id = $1), 0))
     returning id`,
    [studioId, name, String(req.body.description ?? "").trim()],
  );
  await setPrice(studioId, { packageId: r.rows[0].id }, cents);
  backTo(res, "packages", { saved: `${name} created. Tick what's in it, switch it on, and save.` });
});

app.post("/admin/package/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return backTo(res, "packages", { error: "Unknown package." });
  const { studioId } = await ensureStudioAndStaff();
  const name = String(req.body.name ?? "").trim();
  const cents = parseRands(req.body.price);
  if (!name) return backTo(res, "packages", { error: "A package needs a name." });
  if (cents === null) return backTo(res, "packages", { error: BAD_PRICE });
  const owned = await pool.query(`select 1 from package where id = $1 and studio_id = $2`, [req.params.id, studioId]);
  if (owned.rowCount === 0) return backTo(res, "packages", { error: "Unknown package." });

  await savePackageContents(studioId, req.params.id, req.body);
  const description = String(req.body.description ?? "").trim() || (await describeContents(req.params.id));
  await pool.query(
    `update package set name_i18n = jsonb_build_object('en', $1::text),
                        description_i18n = jsonb_build_object('en', $2::text), active = $3
      where id = $4`,
    [name, description, req.body.active === "on", req.params.id],
  );
  await setPrice(studioId, { packageId: req.params.id }, cents);
  backTo(res, "packages", { saved: `${name} saved — ${formatRands(cents)}${req.body.active === "on" ? "" : ", hidden from parents"}.` });
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
        const childId = await findOrCreateChild(studioId, school.id, first, last);
        await ensureEnrolment(studioId, school.id, childId, inner[0]!, inner[1]!);
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

/**
 * Same child if the full name matches ignoring accents, case and spacing —
 * so re-importing "Zané du Toit" finds the "Zane Du Toit" an older import
 * created, instead of making a second child with a second gallery.
 */
async function findOrCreateChild(studioId: string, schoolId: string, first: string, last: string): Promise<string> {
  const existing = await pool.query(
    `select id from child where studio_id = $1 and school_id = $2 and status = 'active'
        and regexp_replace(lower(app.immutable_unaccent(first_name || ' ' || last_name)), '\\s+', ' ', 'g')
          = regexp_replace(lower(app.immutable_unaccent($3 || ' ' || $4)), '\\s+', ' ', 'g')
      order by created_at limit 1`,
    [studioId, schoolId, first, last],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const r = await pool.query(
    `insert into child (studio_id, school_id, first_name, last_name) values ($1,$2,$3,$4) returning id`,
    [studioId, schoolId, first, last],
  );
  return r.rows[0].id;
}

/**
 * Record grade and class from the folder path. Imports never did, so the
 * gallery, the claim cards and the admin could not say which class a child
 * was in. Unrecognisable folder names are skipped rather than guessed.
 */
async function ensureEnrolment(studioId: string, schoolId: string, childId: string, gradeRaw: string, classRaw: string) {
  const g = parseGrade(gradeRaw);
  const k = parseClass(classRaw);
  if (!g || !k) return;
  const year = new Date().getFullYear();
  const sort = g.level === "RR" ? -2 : g.level === "R" ? -1 : Number(g.level) || 0;
  const grade = await pool.query(
    `insert into grade (studio_id, school_id, name, name_norm, sort_order) values ($1,$2,$3,$4,$5)
     on conflict (school_id, name_norm) do update set name = grade.name returning id`,
    [studioId, schoolId, g.canonical, g.level.toLowerCase(), sort],
  );
  const klass = await pool.query(
    `insert into class_group (studio_id, school_id, grade_id, name, name_norm, academic_year) values ($1,$2,$3,$4,$5,$6)
     on conflict (school_id, grade_id, name_norm, academic_year) do update set name = class_group.name returning id`,
    [studioId, schoolId, grade.rows[0].id, k.canonical, compactName(k.canonical), year],
  );
  await pool.query(
    `insert into enrolment (studio_id, child_id, class_group_id, academic_year) values ($1,$2,$3,$4)
     on conflict (child_id, academic_year) do update set class_group_id = excluded.class_group_id`,
    [studioId, childId, klass.rows[0].id, year],
  );
}

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

    const childId = await findOrCreateChild(studioId, schoolId, firstName, lastName);

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
    const studio = (await pool.query(`select id from studio limit 1`)).rows[0];
    const y = studio ? await yocoStatus(pool, studio.id) : null;
    res.json({
      ok: true,
      db: "connected",
      migrations: bootState.migrations,
      parentAccess: rlsEnforcedForParents() ? "session+rls" : "session",
      payments: y?.connected ? { provider: "yoco", mode: y.mode, webhook: y.webhookReady } : { provider: "manual" },
    });
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

app.get("/admin/api/schools", requireStaffAuth, async (_req, res) => {
  const rows = await pool.query(
    `select s.id, s.name, s.display_name,
            (select count(*) from child c where c.school_id = s.id) as children
       from school s order by s.name`,
  );
  res.json(rows.rows);
});

app.post("/admin/api/school/:id/delete", requireStaffAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const id = req.params.id;
    // Dependent rows are deleted in dependency order rather than relying on
    // cascade — most foreign keys in this schema are RESTRICT deliberately
    // (§5.4: soft state, not soft delete, is the default), so a maintenance
    // tool that actually needs hard deletion has to walk the graph itself.
    // Orders and everything hanging off them, then parent bindings.
    await client.query(`delete from download_grant where order_id in (select id from "order" where school_id = $1)`, [id]);
    await client.query(`update payment_event set order_id = null where order_id in (select id from "order" where school_id = $1)`, [id]);
    await client.query(`delete from payment where order_id in (select id from "order" where school_id = $1)`, [id]);
    await client.query(`delete from order_line where order_id in (select id from "order" where school_id = $1)`, [id]);
    await client.query(`delete from "order" where school_id = $1`, [id]);
    await client.query(`delete from consent_record where child_id in (select id from child where school_id = $1)`, [id]);
    await client.query(`delete from guardian_child where child_id in (select id from child where school_id = $1)`, [id]);
    await client.query(`delete from claim_attempt where claim_code_id in (select id from claim_code where shoot_id in
      (select id from shoot where school_id = $1))`, [id]);
    await client.query(
      `delete from gallery_item where asset_id in (select id from asset where shoot_id in
         (select id from shoot where school_id = $1))`, [id],
    );
    await client.query(
      `delete from asset_variant where asset_id in (select id from asset where shoot_id in
         (select id from shoot where school_id = $1))`, [id],
    );
    await client.query(`delete from asset where shoot_id in (select id from shoot where school_id = $1)`, [id]);
    await client.query(`delete from claim_code where shoot_id in (select id from shoot where school_id = $1)`, [id]);
    await client.query(`delete from shoot where school_id = $1`, [id]);
    await client.query(`delete from enrolment where class_group_id in
      (select id from class_group where school_id = $1)`, [id]);
    await client.query(`delete from class_group where school_id = $1`, [id]);
    await client.query(`delete from grade where school_id = $1`, [id]);
    await client.query(`delete from child where school_id = $1`, [id]);
    await client.query(`delete from school where id = $1`, [id]);
    // A guardian with no children, orders or consent left is personal data
    // with no purpose (POPIA s14) — remove it with the school.
    await client.query(`delete from guardian g where true
      and not exists (select 1 from guardian_child gc where gc.guardian_id = g.id)
      and not exists (select 1 from "order" o where o.guardian_id = g.id)
      and not exists (select 1 from consent_record cr where cr.guardian_id = g.id)`);
    await client.query("commit");
    res.json({ deleted: id });
  } catch (err) {
    await client.query("rollback");
    res.status(500).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});

const bootState = { migrations: "pending" as string };

// Boot: bring the schema up to date, find out whether the database can
// enforce parent isolation itself, and make sure Yoco knows where to call.
// None of it needs a human; failures are logged and surfaced on /api/health.
const migration = await migrateOnBoot(pool);
bootState.migrations = migration.status;
await probeRlsRole(pool);
try {
  const { studioId } = await ensureStudioAndStaff();
  await ensureYocoWebhook(pool, studioId);
} catch (err) {
  console.error({ event: "boot.payments", err: (err as Error).message });
}

app.listen(PORT, () => {
  console.log(`\n  Server running on port ${PORT}. (auto-deploy pipeline verified)`);
  console.log(`  → /              parent claim entry`);
  console.log(`  → /admin         studio console (staff auth)`);
  console.log(`  → /import.html   import tool (staff auth)\n`);
});

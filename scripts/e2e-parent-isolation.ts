/**
 * End-to-end attack test for "no parent may ever see another child's
 * photographs", run against a real server over HTTP.
 *
 *   BASE_URL=http://localhost:3000 STAFF_USER=x STAFF_PASSWORD=y npx tsx scripts/e2e-parent-isolation.ts
 *
 * It imports a throwaway school of two children (synthetic solid-colour
 * images, no real people), claims each child from a separate "browser", then
 * attacks across the boundary in every way the routes allow. The school and
 * everything hanging off it is deleted at the end, pass or fail.
 *
 * With E2E_DATABASE_URL set (local only) it also exercises the Yoco webhook:
 * a correctly signed payment.succeeded settles the order and grants
 * downloads; forged and tampered deliveries do not.
 */
import sharp from "sharp";
import pg from "pg";
import { createHmac, randomBytes } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(`${process.env.STAFF_USER}:${process.env.STAFF_PASSWORD}`).toString("base64");
const SCHOOL = `E2E Isolation Check ${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  pass  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

class Browser {
  cookie = "";
  constructor(public label: string) {}
  async req(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.json !== undefined) { headers.set("content-type", "application/json"); init.body = JSON.stringify(init.json); }
    const r = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
    const set = r.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    return r;
  }
}

const staff = (path: string, init: RequestInit = {}) =>
  fetch(BASE + path, { ...init, headers: { ...(init.headers as any), authorization: AUTH }, redirect: "manual" });

async function jpeg(r: number, g: number, b: number) {
  return sharp({ create: { width: 1200, height: 1800, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
}

async function main() {
  console.log(`\nE2E parent isolation against ${BASE}\n`);

  // ── Import a two-child school ─────────────────────────────────────────────
  const form = new FormData();
  const files: Array<[string, Buffer]> = [
    [`${SCHOOL}/Grade 1/Class A/Alice Testcase/a1.jpg`, await jpeg(200, 40, 40)],
    [`${SCHOOL}/Grade 1/Class A/Alice Testcase/a2.jpg`, await jpeg(210, 50, 50)],
    [`${SCHOOL}/Grade 1/Class A/Bongani Testcase/b1.jpg`, await jpeg(40, 40, 200)],
  ];
  for (const [path, buf] of files) {
    form.append("files", new Blob([buf], { type: "image/jpeg" }), path.split("/").pop()!);
    form.append("relativePaths", path);
  }
  const up = await (await staff("/api/import/upload", { method: "POST", body: form })).json() as any;
  if (!up.batchId) throw new Error("upload failed: " + JSON.stringify(up));
  const schoolId = up.schoolId as string;

  try {
    const commit = await (await staff(`/api/import/${up.batchId}/commit`, { method: "POST" })).json() as any;
    const codeFor = (name: string) => commit.claimCodes.find((c: any) => c.child.startsWith(name))?.grouped as string;
    const codeA = codeFor("Alice"), codeB = codeFor("Bongani");
    check("import issued a code per child", !!codeA && !!codeB, JSON.stringify(commit.claimCodes));

    // ── Claim ───────────────────────────────────────────────────────────────
    const A = new Browser("A"), B = new Browser("B"), C = new Browser("C"), anon = new Browser("anon");
    const ra = await (await A.req("/api/claim/redeem", { method: "POST", json: { code: codeA } })).json() as any;
    const rb = await (await B.req("/api/claim/redeem", { method: "POST", json: { code: codeB } })).json() as any;
    const childA = ra.childId as string, childB = rb.childId as string;
    check("parent A claimed Alice", !!childA && !!A.cookie);
    check("parent B claimed Bongani", !!childB && !!B.cookie);
    check("A and B got different sessions", A.cookie !== B.cookie);

    // ── Gallery isolation ───────────────────────────────────────────────────
    const ga = await A.req(`/g/${childA}`);
    const gaHtml = await ga.text();
    check("A sees Alice's gallery", ga.status === 200 && gaHtml.includes("Alice"));
    const previewsA = [...gaHtml.matchAll(/\/storage\/variants\/preview\/[0-9a-f]+\.\w+/g)].map((m) => m[0]);
    check("Alice's gallery shows her 2 photographs", new Set(previewsA).size === 2, String(previewsA.length));

    const gab = await A.req(`/g/${childB}`);
    const gabHtml = await gab.text();
    check("A cannot open Bongani's gallery (404)", gab.status === 404);
    check("…and the refusal leaks nothing about Bongani", !gabHtml.includes("Bongani") && !gabHtml.includes("/storage/variants/preview/"));

    const gn = await anon.req(`/g/${childA}`);
    const gnHtml = await gn.text();
    check("no session → Alice's gallery refused", gn.status === 404 && !gnHtml.includes("Alice") && !gnHtml.includes("/storage/variants"));

    const gb = await B.req(`/g/${childB}`);
    const gbHtml = await gb.text();
    check("B sees Bongani's gallery", gb.status === 200 && gbHtml.includes("Bongani"));
    check("B's page contains none of Alice's images", !previewsA.some((p) => gbHtml.includes(p)));

    const forged = new Browser("forged");
    forged.cookie = "session=" + randomBytes(32).toString("base64url");
    check("a forged session token is refused", (await forged.req(`/g/${childA}`)).status === 404);

    // ── Ordering across the boundary ────────────────────────────────────────
    const assetsA = [...gaHtml.matchAll(/data-asset="([0-9a-f-]+)"/g)].map((m) => m[1]!);
    const assetsB = [...gbHtml.matchAll(/data-asset="([0-9a-f-]+)"/g)].map((m) => m[1]!);
    const products = [...gaHtml.matchAll(/class="prod" value="([0-9a-f-]+)" data-name="([^"]*)" data-cents="(\d+)"/g)]
      .map((m) => ({ id: m[1]!, name: m[2]!, cents: Number(m[3]) }));
    const digital = products.find((p) => /digital/i.test(p.name))!;
    const print = products.find((p) => /A4/i.test(p.name))!;
    check("catalogue present out of the box", !!digital && !!print);

    const xo = await A.req("/api/order", { method: "POST", json: {
      childId: childB, email: "a@example.com", assetIds: assetsB, productIds: [digital.id] } });
    check("A cannot order for Bongani (403)", xo.status === 403);

    const xa = await A.req("/api/order", { method: "POST", json: {
      childId: childA, email: "a@example.com", assetIds: [assetsA[0], assetsB[0]], productIds: [digital.id] } });
    check("A cannot smuggle Bongani's photo into Alice's order", xa.status === 400);

    check("no session cannot order", (await anon.req("/api/order", { method: "POST", json: {
      childId: childA, email: "x@example.com", assetIds: assetsA, productIds: [digital.id] } })).status === 403);

    const ok = await A.req("/api/order", { method: "POST", json: {
      childId: childA, email: "a@example.com", assetIds: [assetsA[0]], productIds: [digital.id, print.id], cents: 1 } });
    const order = await ok.json() as any;
    const expected = digital.cents + print.cents;
    check("A's real order is accepted", ok.status === 200 && !!order.orderNumber, JSON.stringify(order));
    check(`order total is exactly R${(expected / 100).toFixed(2)} (server-priced)`, order.total === expected, String(order.total));

    // B knowing A's order number must get nothing.
    check("B cannot open A's order page", (await B.req(`/order/${order.orderNumber}`)).status === 404);
    check("no session cannot open A's order page", (await anon.req(`/order/${order.orderNumber}`)).status === 404);
    check("B cannot start payment on A's order", (await B.req(`/order/${order.orderNumber}/pay`, { method: "POST" })).status === 404);
    const op = await A.req(`/order/${order.orderNumber}`);
    check("A can open their own order page", op.status === 200 && (await op.text()).includes(order.orderNumber));

    // ── Webhook: forged deliveries never settle anything ────────────────────
    const fake = JSON.stringify({ id: "evt_forged", type: "payment.succeeded",
      payload: { amount: expected, currency: "ZAR", metadata: { checkoutId: "ch_x" } } });
    const fw = await fetch(BASE + "/api/payments/yoco/webhook", { method: "POST", body: fake, headers: {
      "content-type": "application/json", "webhook-id": "msg_x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": "v1," + randomBytes(32).toString("base64") } });
    check("unsigned/forged webhook is rejected", fw.status === 401 || fw.status === 503, String(fw.status));

    // ── Settlement + downloads ──────────────────────────────────────────────
    let settledVia = "mark-paid";
    if (process.env.E2E_DATABASE_URL) {
      settledVia = "yoco-webhook";
      const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
      await db.connect();
      try {
        const o = (await db.query(`select id, studio_id from "order" where order_number = $1`, [order.orderNumber])).rows[0];
        const secretRaw = randomBytes(24);
        const prev = (await db.query(`select value from studio_setting where studio_id = $1 and key = 'yoco'`, [o.studio_id])).rows[0];
        await db.query(
          `insert into studio_setting (studio_id, key, value) values ($1,'yoco',$2)
           on conflict (studio_id, key) do update set value = excluded.value`,
          [o.studio_id, JSON.stringify({ webhookSecret: "whsec_" + secretRaw.toString("base64") })],
        );
        const checkoutId = "ch_e2e_" + randomBytes(6).toString("hex");
        await db.query(`insert into payment (studio_id, order_id, provider, provider_ref, amount_cents, status)
                        values ($1,$2,'yoco',$3,$4,'initiated')`, [o.studio_id, o.id, checkoutId, expected]);
        const send = async (amount: number, evtId: string) => {
          const body = JSON.stringify({ id: evtId, type: "payment.succeeded", createdDate: new Date().toISOString(),
            payload: { id: "p_" + evtId, type: "payment", status: "succeeded", mode: "test", amount, currency: "ZAR",
                       metadata: { checkoutId } } });
          const ts = String(Math.floor(Date.now() / 1000));
          const sig = createHmac("sha256", secretRaw).update(`${evtId}.${ts}.${body}`).digest("base64");
          return fetch(BASE + "/api/payments/yoco/webhook", { method: "POST", body, headers: {
            "content-type": "application/json", "webhook-id": evtId, "webhook-timestamp": ts, "webhook-signature": "v1," + sig } });
        };
        const run = randomBytes(4).toString("hex");
        const under = await send(200, `evt_under_${run}`);
        const st1 = (await db.query(`select payment_status from "order" where id = $1`, [o.id])).rows[0].payment_status;
        check("signed webhook for the WRONG amount does not settle", under.status === 200 && st1 !== "settled", st1);
        const good = await send(expected, `evt_good_${run}`);
        const st2 = (await db.query(`select payment_status, digital_status from "order" where id = $1`, [o.id])).rows[0];
        check("signed webhook for the right amount settles + releases digital",
          good.status === 200 && st2.payment_status === "settled" && st2.digital_status === "delivered", JSON.stringify(st2));
        const dup = await send(expected, `evt_good_${run}`);
        check("duplicate delivery is harmless", dup.status === 200);
        if (prev) await db.query(`update studio_setting set value = $2 where studio_id = $1 and key = 'yoco'`, [o.studio_id, prev.value]);
        else await db.query(`delete from studio_setting where studio_id = $1 and key = 'yoco'`, [o.studio_id]);
      } finally {
        await db.end();
      }
    } else {
      const admin = await (await staff(`/admin?school=${schoolId}`)).text();
      const idx = admin.indexOf(order.orderNumber);
      const m = admin.slice(idx).match(/\/admin\/order\/([0-9a-f-]+)\/mark-paid/);
      check("admin lists the order", idx >= 0 && !!m);
      if (m) await staff(`/admin/order/${m[1]}/mark-paid`, { method: "POST" });
    }

    const paidPage = await (await A.req(`/order/${order.orderNumber}`)).text();
    const grants = [...paidPage.matchAll(/\/download\/([0-9a-f-]+)/g)].map((x) => x[1]!);
    check(`paid (${settledVia}) → A sees exactly one download`, grants.length === 1, String(grants.length));
    if (grants[0]) {
      const dl = await A.req(`/download/${grants[0]}`);
      const bytes = Buffer.from(await dl.arrayBuffer());
      check("A downloads the full-resolution original", dl.status === 200 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length > 1000);
      check("B cannot use A's download link", (await B.req(`/download/${grants[0]}`)).status === 404);
      check("no session cannot use A's download link", (await anon.req(`/download/${grants[0]}`)).status === 404);
    }

    // ── Card re-entry on another device ─────────────────────────────────────
    const rc = await C.req("/api/claim/redeem", { method: "POST", json: { code: codeA } });
    check("Alice's card works again on a second phone", rc.status === 200);
    check("…which sees Alice", (await C.req(`/g/${childA}`)).status === 200);
    check("…but not Bongani", (await C.req(`/g/${childB}`)).status === 404);
    check("…and not parent A's order (separate account)", (await C.req(`/order/${order.orderNumber}`)).status === 404);

    // ── Staff ──────────────────────────────────────────────────────────────
    check("staff can preview any gallery", (await staff(`/admin/preview/${childB}`)).status === 200);
    check("staff preview requires staff auth", (await fetch(BASE + `/admin/preview/${childB}`)).status === 401);
  } finally {
    const del = await staff(`/admin/api/school/${schoolId}/delete`, { method: "POST" });
    check("test school cleaned up", del.status === 200, await del.text());
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });

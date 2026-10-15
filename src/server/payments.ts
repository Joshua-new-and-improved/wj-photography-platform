import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  createCheckout, deleteWebhook, keyMode, listWebhooks, registerWebhook,
  verifyWebhookSignature, YOCO_MIN_CENTS, type YocoMode,
} from "../lib/payments/yoco.js";

/**
 * Payments, end to end, with nothing for Wiaan to do beyond pasting his Yoco
 * secret key once (admin → Payments, or the YOCO_SECRET_KEY variable).
 *
 *   key saved ─► webhook registered with Yoco automatically, secret stored
 *   order placed ─► Yoco checkout created for the SERVER-computed total
 *   Yoco webhook (signed) ─► payment settled ─► digital downloads granted
 *
 * Settlement happens only on a verified webhook whose amount equals the
 * order total. The parent's browser returning to the success page settles
 * nothing.
 */

const SETTING_KEY = "yoco";
const WEBHOOK_NAME = "wj-photography";
export const WEBHOOK_PATH = "/api/payments/yoco/webhook";
const DOWNLOAD_DAYS = 365;

interface YocoSetting {
  secretKey?: string;
  keyFingerprint?: string;
  webhookId?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  registeredAt?: string;
  lastError?: string | undefined;
}

export interface YocoStatus {
  connected: boolean;
  mode: YocoMode | null;
  source: "env" | "admin" | null;
  webhookReady: boolean;
  lastError: string | null;
}

const fingerprint = (k: string) => createHash("sha256").update(k).digest("hex").slice(0, 16);

async function readSetting(pool: Pool, studioId: string): Promise<YocoSetting> {
  const r = await pool.query(`select value from studio_setting where studio_id = $1 and key = $2`, [studioId, SETTING_KEY]);
  return (r.rows[0]?.value ?? {}) as YocoSetting;
}

async function writeSetting(pool: Pool, studioId: string, v: YocoSetting): Promise<void> {
  await pool.query(
    `insert into studio_setting (studio_id, key, value) values ($1, $2, $3)
     on conflict (studio_id, key) do update set value = excluded.value, updated_at = now()`,
    [studioId, SETTING_KEY, JSON.stringify(v)],
  );
}

/** The env var wins, so an operator can always override what was typed in admin. */
function effectiveKey(s: YocoSetting): { key: string; source: "env" | "admin" } | null {
  const env = process.env.YOCO_SECRET_KEY?.trim();
  if (env) return { key: env, source: "env" };
  if (s.secretKey) return { key: s.secretKey, source: "admin" };
  return null;
}

/**
 * Public origin of this deployment. Railway injects RAILWAY_PUBLIC_DOMAIN, so
 * nothing needs configuring; PUBLIC_BASE_URL overrides it (e.g. once
 * wjphotography.co.za points here).
 */
export function publicOrigin(): string | null {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

export async function yocoStatus(pool: Pool, studioId: string): Promise<YocoStatus> {
  const s = await readSetting(pool, studioId);
  const k = effectiveKey(s);
  return {
    connected: !!k,
    mode: k ? keyMode(k.key) : null,
    source: k?.source ?? null,
    webhookReady: !!(k && s.webhookSecret && s.keyFingerprint === fingerprint(k.key) && s.webhookUrl === webhookUrl()),
    lastError: s.lastError ?? null,
  };
}

const webhookUrl = () => {
  const o = publicOrigin();
  return o ? o + WEBHOOK_PATH : null;
};

/**
 * Make sure Yoco will call us. Idempotent: does nothing if the stored
 * registration matches the current key and URL. Otherwise removes any of our
 * own stale subscriptions (same name or same URL) and registers afresh —
 * Yoco only reveals the signing secret at registration, so re-registering is
 * the only way to recover it.
 */
export async function ensureYocoWebhook(pool: Pool, studioId: string): Promise<YocoStatus> {
  const s = await readSetting(pool, studioId);
  const k = effectiveKey(s);
  const url = webhookUrl();
  if (!k || !url) return yocoStatus(pool, studioId);
  if (s.webhookSecret && s.keyFingerprint === fingerprint(k.key) && s.webhookUrl === url) {
    return yocoStatus(pool, studioId);
  }
  try {
    if (!keyMode(k.key)) throw new Error("That does not look like a Yoco secret key (it should start with sk_test_ or sk_live_).");
    for (const sub of await listWebhooks(k.key)) {
      if (sub.name === WEBHOOK_NAME || sub.url === url) await deleteWebhook(k.key, sub.id);
    }
    const reg = await registerWebhook(k.key, WEBHOOK_NAME, url);
    await writeSetting(pool, studioId, {
      ...s,
      keyFingerprint: fingerprint(k.key),
      webhookId: reg.id,
      webhookSecret: reg.secret,
      webhookUrl: url,
      registeredAt: new Date().toISOString(),
      lastError: undefined,
    });
    console.log({ event: "yoco.webhook.registered", mode: reg.mode, url });
  } catch (err) {
    await writeSetting(pool, studioId, { ...s, lastError: (err as Error).message });
    console.error({ event: "yoco.webhook.failed", err: (err as Error).message });
  }
  return yocoStatus(pool, studioId);
}

/** Admin pasted a key (or cleared it with an empty string). */
export async function saveYocoKey(pool: Pool, studioId: string, key: string): Promise<YocoStatus> {
  const s = await readSetting(pool, studioId);
  const trimmed = key.trim();
  if (!trimmed) {
    const k = effectiveKey(s);
    if (k?.source === "admin" && s.webhookId) await deleteWebhook(k.key, s.webhookId).catch(() => {});
    await writeSetting(pool, studioId, {});
    return yocoStatus(pool, studioId);
  }
  if (!keyMode(trimmed)) {
    await writeSetting(pool, studioId, { ...s, lastError: "That does not look like a Yoco secret key (it should start with sk_test_ or sk_live_)." });
    return yocoStatus(pool, studioId);
  }
  await writeSetting(pool, studioId, { secretKey: trimmed });
  return ensureYocoWebhook(pool, studioId);
}

/**
 * Start (or restart) card payment for an order. Returns the URL to send the
 * parent to, or null when Yoco isn't connected / the amount is under R2.
 */
export async function startCheckout(pool: Pool, orderId: string, origin: string): Promise<string | null> {
  const o = (await pool.query(
    `select o.id, o.studio_id, o.order_number, o.total_cents, o.payment_status,
            (select ol.child_id from order_line ol where ol.order_id = o.id limit 1) as child_id
       from "order" o where o.id = $1`,
    [orderId],
  )).rows[0];
  if (!o || o.payment_status === "settled") return null;
  const amount = Number(o.total_cents);
  if (amount < YOCO_MIN_CENTS) return null;

  const s = await readSetting(pool, o.studio_id);
  const k = effectiveKey(s);
  if (!k) return null;

  // One checkout per attempt; the attempt number keeps Yoco's idempotency
  // from handing back a checkout that already failed.
  const attempt = Number((await pool.query(
    `select count(*) as n from payment where order_id = $1 and provider = 'yoco'`, [orderId],
  )).rows[0].n) + 1;

  const base = (process.env.PUBLIC_BASE_URL ?? origin).replace(/\/$/, "");
  const checkout = await createCheckout(k.key, {
    amountCents: amount,
    successUrl: `${base}/order/${o.order_number}?returned=1`,
    cancelUrl: `${base}/order/${o.order_number}?cancelled=1`,
    failureUrl: `${base}/order/${o.order_number}?failed=1`,
    metadata: { orderId: o.id, orderNumber: o.order_number },
    externalId: o.order_number,
    idempotencyKey: `${o.id}-${attempt}`,
  });

  await pool.query(
    `insert into payment (studio_id, order_id, provider, provider_ref, method, amount_cents, status)
     values ($1, $2, 'yoco', $3, 'card', $4, 'initiated')
     on conflict (provider, provider_ref) do nothing`,
    [o.studio_id, o.id, checkout.id, amount],
  );
  await pool.query(
    `update "order" set payment_status = 'initiated' where id = $1 and payment_status in ('pending','failed','abandoned','initiated')`,
    [o.id],
  );
  return checkout.redirectUrl;
}

/**
 * Settle an order and release whatever it bought digitally. Used by the Yoco
 * webhook and by the admin "Mark paid" button (cash / EFT), so both paths
 * produce exactly the same outcome. Idempotent.
 */
export async function settleOrder(client: PoolClient, orderId: string): Promise<void> {
  await client.query(`update "order" set payment_status = 'settled' where id = $1`, [orderId]);

  const o = (await client.query(`select studio_id, guardian_id from "order" where id = $1`, [orderId])).rows[0];
  const digitalLines = await client.query(
    `select snapshot from order_line where order_id = $1 and fulfilment_kind = 'digital'`, [orderId],
  );
  if (digitalLines.rowCount === 0) return;

  const assetIds = new Set<string>();
  for (const l of digitalLines.rows) {
    if (l.snapshot?.assetId) assetIds.add(l.snapshot.assetId);
    for (const a of l.snapshot?.assetIds ?? []) assetIds.add(a);
  }
  for (const assetId of assetIds) {
    await client.query(
      `insert into download_grant (studio_id, order_id, guardian_id, asset_id, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(days => $5))
       on conflict (order_id, asset_id, guardian_id) do nothing`,
      [o.studio_id, orderId, o.guardian_id, assetId, DOWNLOAD_DAYS],
    );
  }
  await client.query(`update "order" set digital_status = 'delivered' where id = $1`, [orderId]);
}

/**
 * Yoco webhook. `rawBody` is the exact bytes received (signature covers them).
 * Returns the HTTP status to send: 2xx tells Yoco to stop retrying.
 */
export async function handleYocoWebhook(
  pool: Pool, headers: Record<string, string | string[] | undefined>, rawBody: string, ip: string | undefined,
): Promise<number> {
  const studio = (await pool.query(`select id from studio limit 1`)).rows[0];
  if (!studio) return 404;
  const s = await readSetting(pool, studio.id);
  if (!s.webhookSecret) return 503;

  const h = (n: string) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
  const verdict = verifyWebhookSignature({
    secret: s.webhookSecret,
    id: h("webhook-id"),
    timestamp: h("webhook-timestamp"),
    signatureHeader: h("webhook-signature"),
    rawBody,
  });
  if (!verdict.ok) {
    console.warn({ event: "yoco.webhook.rejected", reason: verdict.reason, ip });
    return 401;
  }

  let evt: any;
  try { evt = JSON.parse(rawBody); } catch { return 400; }
  const eventId = String(evt.id ?? h("webhook-id"));

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor_kind', 'system', true)");

    const ins = await client.query(
      `insert into payment_event (provider, provider_event_id, signature_valid, source_ip, payload)
       values ('yoco', $1, true, $2, $3)
       on conflict (provider, provider_event_id) do nothing returning id`,
      [eventId, ip ?? null, rawBody],
    );
    if (ins.rowCount === 0) { await client.query("commit"); return 200; } // duplicate delivery
    const eventRowId = ins.rows[0].id;

    const checkoutId = evt.payload?.metadata?.checkoutId as string | undefined;
    const pay = checkoutId
      ? (await client.query(
          `select p.id, p.order_id, o.total_cents, o.payment_status
             from payment p join "order" o on o.id = p.order_id
            where p.provider = 'yoco' and p.provider_ref = $1 for update of o`,
          [checkoutId],
        )).rows[0]
      : undefined;

    let error: string | null = null;
    if (!pay) {
      error = "no matching checkout";
    } else if (evt.type === "payment.succeeded") {
      if (Number(evt.payload?.amount) !== Number(pay.total_cents) || evt.payload?.currency !== "ZAR") {
        error = `amount mismatch: paid ${evt.payload?.amount} ${evt.payload?.currency}, order total ${pay.total_cents}`;
      } else {
        await client.query(
          `update payment set status = 'settled', settled_at = now(), method = coalesce($2, method) where id = $1`,
          [pay.id, evt.payload?.paymentMethodDetails?.type ?? null],
        );
        await settleOrder(client, pay.order_id);
      }
    } else if (evt.type === "payment.failed") {
      await client.query(`update payment set status = 'failed' where id = $1`, [pay.id]);
      await client.query(`update "order" set payment_status = 'failed' where id = $1 and payment_status <> 'settled'`, [pay.order_id]);
    }

    await client.query(
      `update payment_event set order_id = $2, processed_at = now(), processing_error = $3 where id = $1`,
      [eventRowId, pay?.order_id ?? null, error],
    );
    await client.query("commit");
    if (error) console.error({ event: "yoco.webhook.unprocessed", eventId, error });
    return 200;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error({ event: "yoco.webhook.error", err: (err as Error).message });
    return 500; // Yoco retries
  } finally {
    client.release();
  }
}

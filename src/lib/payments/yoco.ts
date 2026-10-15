import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Yoco Checkout API — the card gateway.
 *
 * Flow: create a checkout for an order's server-computed total, send the
 * parent to Yoco's hosted page, and settle the order ONLY when a signed
 * `payment.succeeded` webhook arrives. The browser coming back to the success
 * URL proves nothing — anyone can type that URL — so it is never used to
 * settle anything.
 *
 * Reference: https://developer.yoco.com/api-reference/checkout-api
 */

const API = "https://payments.yoco.com/api";

/** Yoco refuses checkouts under R2.00. */
export const YOCO_MIN_CENTS = 200;

/** Docs recommend rejecting events whose timestamp is more than ~3 minutes off. */
export const SIGNATURE_TOLERANCE_SECONDS = 180;

export type YocoMode = "test" | "live";

export function keyMode(secretKey: string): YocoMode | null {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  return null;
}

async function call<T>(secretKey: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(API + path, init);
  const text = await res.text();
  if (!res.ok) {
    // Never echo the key; the response body is Yoco's own error description.
    throw new Error(`Yoco ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface Checkout {
  id: string;
  redirectUrl: string;
  status: string;
  processingMode?: YocoMode;
}

export function createCheckout(
  secretKey: string,
  opts: {
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    failureUrl: string;
    metadata: Record<string, string>;
    externalId: string;
    idempotencyKey: string;
  },
): Promise<Checkout> {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents < YOCO_MIN_CENTS) {
    throw new Error(`Amount ${opts.amountCents} cents is below Yoco's R2.00 minimum.`);
  }
  return call<Checkout>(
    secretKey, "POST", "/checkouts",
    {
      amount: opts.amountCents,
      currency: "ZAR",
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
      failureUrl: opts.failureUrl,
      metadata: opts.metadata,
      externalId: opts.externalId,
    },
    opts.idempotencyKey,
  );
}

export interface WebhookSubscription { id: string; name: string; url: string; mode: YocoMode }

export async function listWebhooks(secretKey: string): Promise<WebhookSubscription[]> {
  const r = await call<{ subscriptions: WebhookSubscription[] }>(secretKey, "GET", "/webhooks");
  return r.subscriptions ?? [];
}

export function registerWebhook(secretKey: string, name: string, url: string): Promise<WebhookSubscription & { secret: string }> {
  return call(secretKey, "POST", "/webhooks", { name, url });
}

export function deleteWebhook(secretKey: string, id: string): Promise<unknown> {
  return call(secretKey, "DELETE", `/webhooks/${encodeURIComponent(id)}`);
}

/**
 * Verify a webhook delivery (Standard Webhooks scheme, as Yoco documents it):
 * HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}`, keyed with
 * the base64-decoded part of the secret after `whsec_`, compared in constant
 * time against every `v1,<sig>` entry in the header.
 *
 * `rawBody` must be the exact bytes received — re-serialised JSON will not
 * match.
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { secret, id, timestamp, signatureHeader, rawBody } = opts;
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: "missing headers" };

  const ts = Number(timestamp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) return { ok: false, reason: "unusable secret" };

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  for (const entry of signatureHeader.split(" ")) {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

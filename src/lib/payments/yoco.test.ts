import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { keyMode, verifyWebhookSignature, createCheckout } from "./yoco.js";

const rawSecret = randomBytes(24);
const secret = "whsec_" + rawSecret.toString("base64");
const now = 1_760_000_000;

function sign(id: string, ts: number, body: string, key = rawSecret) {
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "payment.succeeded", payload: { amount: 63000 } });

  it("accepts a correctly signed, fresh delivery", () => {
    const r = verifyWebhookSignature({
      secret, id: "msg_1", timestamp: String(now), signatureHeader: sign("msg_1", now, body), rawBody: body, nowSeconds: now,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts when the valid signature is not the first entry", () => {
    const header = "v1,AAAA " + sign("msg_1", now, body);
    const r = verifyWebhookSignature({ secret, id: "msg_1", timestamp: String(now), signatureHeader: header, rawBody: body, nowSeconds: now });
    expect(r.ok).toBe(true);
  });

  it("rejects a body altered after signing — e.g. the amount changed", () => {
    const forged = body.replace("63000", "200");
    const r = verifyWebhookSignature({
      secret, id: "msg_1", timestamp: String(now), signatureHeader: sign("msg_1", now, body), rawBody: forged, nowSeconds: now,
    });
    expect(r).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a delivery signed with a different secret", () => {
    const r = verifyWebhookSignature({
      secret, id: "msg_1", timestamp: String(now),
      signatureHeader: sign("msg_1", now, body, randomBytes(24)), rawBody: body, nowSeconds: now,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a replay outside the 3-minute window", () => {
    const old = now - 600;
    const r = verifyWebhookSignature({
      secret, id: "msg_1", timestamp: String(old), signatureHeader: sign("msg_1", old, body), rawBody: body, nowSeconds: now,
    });
    expect(r).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("rejects missing headers rather than throwing", () => {
    const r = verifyWebhookSignature({ secret, id: undefined, timestamp: String(now), signatureHeader: undefined, rawBody: body, nowSeconds: now });
    expect(r.ok).toBe(false);
  });

  it("rejects a moved webhook-id (signature binds the id)", () => {
    const r = verifyWebhookSignature({
      secret, id: "msg_2", timestamp: String(now), signatureHeader: sign("msg_1", now, body), rawBody: body, nowSeconds: now,
    });
    expect(r.ok).toBe(false);
  });
});

describe("keyMode", () => {
  it("reads test/live from the key prefix and rejects anything else", () => {
    expect(keyMode("sk_test_abc")).toBe("test");
    expect(keyMode("sk_live_abc")).toBe("live");
    expect(keyMode("pk_test_abc")).toBeNull();
    expect(keyMode("")).toBeNull();
  });
});

describe("createCheckout", () => {
  it("refuses amounts under Yoco's R2.00 minimum before any network call", () => {
    expect(() =>
      createCheckout("sk_test_x", {
        amountCents: 199, successUrl: "", cancelUrl: "", failureUrl: "", metadata: {}, externalId: "x", idempotencyKey: "x",
      }),
    ).toThrow(/minimum/);
  });

  it("refuses a non-integer amount — the bigint-as-string class of bug", () => {
    expect(() =>
      createCheckout("sk_test_x", {
        amountCents: "63000" as unknown as number, successUrl: "", cancelUrl: "", failureUrl: "", metadata: {}, externalId: "x", idempotencyKey: "x",
      }),
    ).toThrow();
  });
});

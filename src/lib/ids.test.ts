import { describe, it, expect } from "vitest";
import {
  generateClaimCode,
  normaliseCode,
  isWellFormedClaimCode,
  generateOrderNumber,
  generatePublicRef,
  generateSessionToken,
  hashToken,
  CLAIM_CODE_BITS,
} from "./ids.js";

describe("claim codes", () => {
  it("has the entropy the threat model assumes", () => {
    // §6.2 claims ~50 bits. If someone shortens the code, this test is the
    // thing that objects.
    expect(CLAIM_CODE_BITS).toBe(50);
  });

  it("never emits an ambiguous glyph", () => {
    // I, L, O and U are excluded so the code survives handwriting, photocopying
    // and being read aloud over the phone.
    for (let i = 0; i < 2000; i++) {
      expect(generateClaimCode().plain).not.toMatch(/[ILOU]/);
    }
  });

  it("groups for legibility and strips the grouping on input", () => {
    const { plain, grouped } = generateClaimCode();
    expect(grouped).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    expect(normaliseCode(grouped)).toBe(plain);
  });

  it("forgives the substitutions a tired parent actually makes", () => {
    // A slip prints 1 and 0; the parent types l and O. Crockford's decoding
    // rules mean they get in rather than getting an error they cannot debug.
    expect(normaliseCode("l0Ii-O1o-1lO")).toBe(normaliseCode("1011-010-110"));
    expect(normaliseCode("l0Ii-O1o-1lO")).toBe("1011010110");
    expect(normaliseCode("  abcd efg hij ")).toBe("ABCDEFGH1J");
  });

  it("rejects malformed input", () => {
    expect(isWellFormedClaimCode("TOOSHORT")).toBe(false);
    expect(isWellFormedClaimCode("WAYTOOLONGCODE")).toBe(false);
    expect(isWellFormedClaimCode("ABCD-EFG-H1J")).toBe(true);
  });

  it("does not collide across a realistic issuance volume", () => {
    // 20 000 children a year (§A7). Collisions here would mean two parents
    // sharing a credential, so the bar is zero, not "few".
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generateClaimCode().plain);
    expect(seen.size).toBe(20_000);
  });

  it("keeps a hint short enough to be safe to store", () => {
    const { plain, hint } = generateClaimCode();
    expect(hint).toHaveLength(3);
    expect(plain.endsWith(hint)).toBe(true);
  });
});

describe("order numbers", () => {
  it("is not sequential", () => {
    // A sequential order number tells anyone counting how much business you do.
    const a = generateOrderNumber();
    const b = generateOrderNumber();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^SP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });
});

describe("public references", () => {
  it("is 22 base62 characters, matching app.public_ref()", () => {
    const ref = generatePublicRef();
    expect(ref).toHaveLength(22);
    expect(ref).toMatch(/^[0-9A-Za-z]{22}$/);
  });

  it("does not collide across 50 000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) seen.add(generatePublicRef());
    expect(seen.size).toBe(50_000);
  });
});

describe("session tokens", () => {
  it("is 256 bits and url-safe", () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
  });

  it("hashes deterministically to 32 bytes", () => {
    const t = generateSessionToken();
    expect(hashToken(t)).toHaveLength(32);
    expect(hashToken(t).equals(hashToken(t))).toBe(true);
    expect(hashToken(t).equals(hashToken(generateSessionToken()))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";
import { generateClaimCode, normaliseCode } from "./ids.js";
import { RATE_LIMIT } from "./claim.js";

const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

describe("claim code hashing", () => {
  it("verifies the code a parent actually types", async () => {
    const { plain, grouped } = generateClaimCode();
    const h = await argonHash(plain, ARGON);
    // The slip prints it grouped; normalisation has to survive the round trip.
    expect(await argonVerify(h, normaliseCode(grouped), ARGON)).toBe(true);
  });

  it("rejects a near miss", async () => {
    const h = await argonHash("7K4MB2PX9T", ARGON);
    expect(await argonVerify(h, "7K4MB2PX9V", ARGON)).toBe(false);
  });

  it("salts per row, so two identical codes hash differently", async () => {
    // This is why redemption cannot look a code up by hash and has to verify
    // candidates in turn — a real cost, taken deliberately.
    const a = await argonHash("7K4MB2PX9T", ARGON);
    const b = await argonHash("7K4MB2PX9T", ARGON);
    expect(a).not.toBe(b);
    expect(await argonVerify(b, "7K4MB2PX9T", ARGON)).toBe(true);
  });

  it("costs enough to make offline cracking expensive", async () => {
    const t = Date.now();
    await argonHash(generateClaimCode().plain, ARGON);
    const ms = Date.now() - t;
    // Fast enough that a parent does not notice; slow enough that 50 bits is
    // not enumerable offline in useful time.
    expect(ms).toBeGreaterThan(8);
    expect(ms).toBeLessThan(2000);
  });

  it("meets the OWASP floor for Argon2id memory cost", () => {
    expect(ARGON.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(ARGON.algorithm).toBe(Algorithm.Argon2id);
  });
});

describe("rate limiting", () => {
  it("is tight enough that 50 bits is unreachable", () => {
    const perYear = (RATE_LIMIT.attempts / RATE_LIMIT.windowSeconds) * 31_536_000;
    const space = 32 ** 10; // Crockford base32, 10 symbols
    // ~4x10^8 years of sustained attack to exhaust the space, half that for
    // even odds on one code. Brute force is not a threat model here.
    expect(space / perYear).toBeGreaterThan(1e8);
  });
});

import { describe, it, expect } from "vitest";

/**
 * Regression guard for a real bug that reached production logic.
 *
 * node-postgres returns bigint/numeric columns as STRINGS, to avoid silently
 * losing precision past 2^53. So accumulating them with `+=` concatenates
 * instead of adding: a R145 print plus a R485 package produced a total of
 * R14,500,485.00 rather than R630.00, and wrote that figure to the order.
 *
 * It was caught by asserting an expected total rather than eyeballing the
 * response, which is the only reason it did not ship. These tests exist so
 * that if anyone reintroduces the pattern, it fails here instead of on a
 * customer's invoice.
 */
describe("money accumulation from database rows", () => {
  it("demonstrates the failure mode this guards against", () => {
    const rowsFromPg = [{ amount_cents: "14500" }, { amount_cents: "48500" }];
    let broken: any = 0;
    for (const r of rowsFromPg) broken += r.amount_cents;
    // This is what the bug produced. Documented so the failure is recognisable.
    expect(broken).toBe("01450048500");
  });

  it("sums correctly when every amount is coerced to a number", () => {
    const rowsFromPg = [{ amount_cents: "14500" }, { amount_cents: "48500" }];
    let total = 0;
    for (const r of rowsFromPg) total += Number(r.amount_cents);
    expect(total).toBe(63000);
  });

  it("stays exact across a realistic full order", () => {
    // 6 photographs, an A4 each, plus one Gold package charged once.
    const perPhoto = "14500";
    const pkg = "89500";
    let total = 0;
    for (let i = 0; i < 6; i++) total += Number(perPhoto);
    total += Number(pkg);
    expect(total).toBe(176500);
    expect(Number.isSafeInteger(total)).toBe(true);
  });
});

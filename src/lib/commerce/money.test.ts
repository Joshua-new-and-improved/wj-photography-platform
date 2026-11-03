import { describe, expect, it } from "vitest";
import { FORMAT_RANDS_JS, formatRands, parseRands, randsInputValue } from "./money.js";

describe("parseRands — what Wiaan types into the price box", () => {
  it.each([
    ["145", 14500],
    ["145.5", 14550],
    ["145.50", 14550],
    ["145,50", 14550],
    ["R145", 14500],
    ["r 145", 14500],
    ["R 1 450", 145000],
    ["1 450,00", 145000],
    ["1,450.00", 145000],
    ["1,450", 145000],
    ["0", 0],
    ["0.99", 99],
    [" 45 ", 4500],
    [895, 89500],
  ])("%j → %i cents", (input, cents) => {
    expect(parseRands(input)).toBe(cents);
  });

  it.each(["", "  ", "abc", "-45", "45.999", "1.2.3", "14,5,0", "R", "1e3", "NaN", "45 R", "2000000"])(
    "rejects %j rather than guessing",
    (input) => {
      expect(parseRands(input)).toBeNull();
    },
  );

  it("rejects non-strings and non-numbers", () => {
    expect(parseRands(undefined)).toBeNull();
    expect(parseRands(null)).toBeNull();
    expect(parseRands({})).toBeNull();
  });

  it("never produces floating-point cents", () => {
    // 0.1 + 0.2 territory: 4.35 * 100 = 434.99999999999994 in floats.
    expect(parseRands("4.35")).toBe(435);
    expect(Number.isInteger(parseRands("1234.56"))).toBe(true);
  });
});

describe("formatRands — what parents and Wiaan read", () => {
  it("drops .00 on whole Rands and keeps real cents", () => {
    expect(formatRands(14500)).toBe("R145");
    expect(formatRands(14550)).toBe("R145.50");
    expect(formatRands(5)).toBe("R0.05");
    expect(formatRands(0)).toBe("R0");
  });

  it("groups thousands with a space", () => {
    expect(formatRands(145000)).toBe("R1 450");
    expect(formatRands(123456789)).toBe("R1 234 567.89");
  });

  it("accepts the strings node-postgres returns for bigint", () => {
    // The column type that once concatenated R145 + R485 into R14,500,485.
    expect(formatRands("63000")).toBe("R630");
  });

  it("round-trips through parseRands", () => {
    for (const c of [0, 99, 4500, 14550, 145000, 99999999]) {
      expect(parseRands(formatRands(c))).toBe(c);
      expect(parseRands(randsInputValue(c))).toBe(c);
    }
  });

  it("the browser copy formats identically", () => {
    const fn = new Function(`${FORMAT_RANDS_JS}; return formatRands;`)() as (c: number) => string;
    for (const c of [0, 5, 14500, 14550, 145000, 123456789]) expect(fn(c)).toBe(formatRands(c));
  });
});

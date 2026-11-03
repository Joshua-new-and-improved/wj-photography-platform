/**
 * Rands at the edges, cents inside.
 *
 * The database and every calculation stay in integer cents — floating-point
 * Rands are how R0.1 + R0.2 becomes R0.30000000000000004. But nobody should
 * ever have to TYPE cents: Wiaan enters "145" or "R145,50" and parents read
 * "R145". These two functions are the only crossing points.
 */

const MAX_CENTS = 100_000_000; // R1,000,000 — anything above is a typo

/**
 * Parse what a person typed as a Rand amount into integer cents, or null if
 * it isn't one. Accepts "145", "145.5", "145,50" (SA decimal comma),
 * "R 1 450", "1,450.00" and "1 450,00". Rejects negatives, more than two
 * decimals, and anything ambiguous rather than guessing.
 */
export function parseRands(input: unknown): number | null {
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^R/i, "").replace(/[\s  ]/g, "");
  if (!s) return null;

  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) {
    s = s.replace(/,/g, ""); // 1,450.00 — comma thousands
  } else if (/^\d+,\d{1,2}$/.test(s)) {
    s = s.replace(",", "."); // 145,50 — decimal comma
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;

  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return cents;
}

/**
 * Cents → "R145", "R145.50", "R1 450". Whole-Rand amounts drop the ".00";
 * thousands are grouped with a space, the South African convention. Accepts
 * the string that node-postgres returns for bigint columns.
 */
export function formatRands(cents: number | string | bigint): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "R—";
  const neg = n < 0;
  const abs = Math.round(Math.abs(n));
  const rands = Math.floor(abs / 100);
  const rem = abs % 100;
  const grouped = String(rands).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R${grouped}${rem ? "." + String(rem).padStart(2, "0") : ""}`;
}

/** Cents → the plain value for an <input>: "145" or "145.50". */
export function randsInputValue(cents: number | string | bigint | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n)) return "";
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2);
}

/** The same formatter, as source for inline browser scripts. */
export const FORMAT_RANDS_JS = `function formatRands(c){c=Math.round(Math.abs(Number(c)||0));var r=Math.floor(c/100),m=c%100;return 'R'+String(r).replace(/\\B(?=(\\d{3})+(?!\\d))/g,' ')+(m?'.'+String(m).padStart(2,'0'):'');}`;

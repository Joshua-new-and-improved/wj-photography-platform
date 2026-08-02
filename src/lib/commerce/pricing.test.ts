import { describe, it, expect } from "vitest";
import {
  splitVatInclusive, totalOrder, packageSaving,
  defaultCrop, checkDpi, clampCrop, ASPECT, type PrintSize,
} from "./pricing.js";

const A4: PrintSize = { label: "A4", widthMm: 210, heightMm: 297, minDpi: 300 };
const TEN15: PrintSize = { label: "10×15", widthMm: 100, heightMm: 150, minDpi: 300 };
const A3: PrintSize = { label: "A3", widthMm: 297, heightMm: 420, minDpi: 300 };

describe("VAT", () => {
  it("splits an inclusive price so the parts reconstruct the whole", () => {
    for (const gross of [8500, 24500, 48500, 89500, 1, 99, 100_000]) {
      const { netCents, vatCents } = splitVatInclusive(gross, 1500);
      expect(netCents + vatCents).toBe(gross);
    }
  });

  it("gets the textbook case exactly right", () => {
    // R115.00 inclusive at 15% is R100.00 + R15.00.
    expect(splitVatInclusive(11500, 1500)).toEqual({ netCents: 10000, vatCents: 1500 });
  });

  it("suppresses VAT entirely when the studio is not registered", () => {
    // studio.vat_number null ⇒ rate 0. No VAT line, no VAT wording (§11.4).
    expect(splitVatInclusive(24500, 0)).toEqual({ netCents: 24500, vatCents: 0 });
  });
});

describe("order totals", () => {
  it("sums VAT per line, not on the subtotal", () => {
    // These differ by rounding, and the per-line figure is what the invoice
    // shows, so it has to be the authoritative one.
    const lines = Array.from({ length: 7 }, () => ({ unitCents: 3333, quantity: 1, vatRateBps: 1500 }));
    const t = totalOrder(lines);
    const perLine = 7 * splitVatInclusive(3333, 1500).vatCents;
    expect(t.vatCents).toBe(perLine);
    expect(t.subtotalCents).toBe(23331);
  });

  it("adds delivery to the total without inflating commission", () => {
    // The studio does not fundraise for the school on courier fees.
    const t = totalOrder([{ unitCents: 20000, quantity: 1, vatRateBps: 1500 }], {
      deliveryCents: 8500, deliveryVatRateBps: 1500, commissionBps: 1000,
    });
    expect(t.totalCents).toBe(28500);
    expect(t.commissionCents).toBe(2000); // 10% of goods only
  });

  it("never loses or invents a cent", () => {
    const t = totalOrder([
      { unitCents: 8500, quantity: 3, vatRateBps: 1500 },
      { unitCents: 12999, quantity: 1, vatRateBps: 1500 },
    ], { deliveryCents: 0 });
    expect(t.totalCents).toBe(8500 * 3 + 12999);
    expect(t.subtotalCents + t.deliveryCents).toBe(t.totalCents);
  });
});

describe("package savings", () => {
  it("shows the saving that does the selling", () => {
    expect(packageSaving(48500, 63000)).toBe(14500);
  });
  it("shows nothing rather than a negative saving", () => {
    // If a package is not actually cheaper, say nothing. Never "saves -R20".
    expect(packageSaving(50000, 45000)).toBe(0);
  });
});

describe("crop geometry", () => {
  it("knows the print sizes are not the same shape", () => {
    expect(ASPECT(TEN15)).toBeCloseTo(1.5, 3);
    expect(ASPECT(A4)).toBeCloseTo(1.414, 3);
    expect(ASPECT(A3)).toBeCloseTo(1.414, 3);
  });

  it("crops nothing when the shapes already match", () => {
    // A 3:2 frame to a 10×15 print is a straight fit.
    expect(defaultCrop({ width: 4000, height: 6000 }, TEN15)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("takes about 5.7% off a 3:2 frame printed to A4", () => {
    const crop = defaultCrop({ width: 4000, height: 6000 }, A4);
    expect(1 - crop.h).toBeCloseTo(0.0572, 3);
  });

  it("biases the crop upward so it takes shoulder, not scalp", () => {
    const crop = defaultCrop({ width: 4000, height: 6000 }, A4);
    const offTop = crop.y;
    const offBottom = 1 - (crop.y + crop.h);
    // Centre-cropping would split it evenly and clip the top of the head.
    expect(offBottom).toBeGreaterThan(offTop);
    expect(offBottom / (offTop + offBottom)).toBeCloseTo(2 / 3, 2);
  });

  it("trims the sides evenly on a landscape frame", () => {
    const crop = defaultCrop({ width: 6000, height: 4000 }, A4);
    expect(crop.y).toBe(0);
    expect(crop.x).toBeCloseTo((1 - crop.w) / 2, 6);
  });

  it("keeps the print in the source's orientation", () => {
    // A portrait frame gets portrait A4, not A4 rotated into landscape.
    const portrait = defaultCrop({ width: 4000, height: 6000 }, A4);
    const landscape = defaultCrop({ width: 6000, height: 4000 }, A4);
    expect(portrait.h).toBeLessThan(1);
    expect(portrait.w).toBe(1);
    expect(landscape.w).toBeLessThan(1);
    expect(landscape.h).toBe(1);
  });
});

describe("resolution warnings", () => {
  it("passes a full-resolution frame at A3", () => {
    const src = { width: 4000, height: 6000 };
    const c = checkDpi(src, defaultCrop(src, A3), A3);
    expect(c.ok).toBe(true);
    expect(c.warning).toBeNull();
    expect(c.dpi).toBeGreaterThanOrEqual(300);
  });

  it("warns before the sale, not after", () => {
    // A heavily cropped frame blown up to A3. The parent hears about it while
    // choosing — the alternative is a refund request and a reprint.
    const src = { width: 4000, height: 6000 };
    const c = checkDpi(src, { x: 0.3, y: 0.3, w: 0.25, h: 0.35 }, A3);
    expect(c.ok).toBe(false);
    expect(c.warning).toContain("A3");
    expect(c.warning).toContain("soft");
  });

  it("says 'still good' in the middle band rather than blocking the sale", () => {
    const src = { width: 4000, height: 6000 };
    const c = checkDpi(src, { x: 0, y: 0, w: 0.55, h: 0.55 }, A3);
    expect(c.ok).toBe(true);
    expect(c.warning).not.toBeNull();
  });
});

describe("dragged crops", () => {
  it("cannot be dragged outside the frame", () => {
    const c = clampCrop({ x: 0.9, y: -0.4, w: 0.5, h: 0.5 });
    expect(c.x + c.w).toBeLessThanOrEqual(1);
    expect(c.y).toBeGreaterThanOrEqual(0);
  });
  it("cannot be shrunk to nothing or grown past the frame", () => {
    expect(clampCrop({ x: 0, y: 0, w: 0.001, h: 3 })).toMatchObject({ w: 0.05, h: 1 });
  });
});

/**
 * Money, VAT, package savings, and print crop geometry.
 *
 * Everything is integer cents. Every function is pure, so the arithmetic that
 * decides what a parent is charged can be tested exhaustively and replayed
 * from a stored order snapshot years later.
 *
 * Architecture §2.10 (crop), §11 (catalogue and pricing), §12 (orders).
 */

export interface Money {
  cents: number;
  currency: "ZAR";
}

export const zar = (cents: number): Money => ({ cents: Math.round(cents), currency: "ZAR" });

/**
 * Split a VAT-inclusive price into net and VAT.
 *
 * Prices are quoted inclusive because the buyers are consumers and a checkout
 * that adds 15% at the last step reads as a trick (§11.3). SARS requires the
 * VAT portion to appear on a tax invoice, so it has to be derivable exactly.
 *
 * Rounding is half-up on the VAT component, then net is the remainder. Doing
 * it the other way — rounding net and deriving VAT — lets a line total drift
 * a cent away from what the customer was shown, and a cent that does not
 * reconcile costs an hour of somebody's evening.
 */
export function splitVatInclusive(
  grossCents: number,
  vatRateBps: number,
): { netCents: number; vatCents: number } {
  if (vatRateBps === 0) return { netCents: grossCents, vatCents: 0 };
  // gross = net * (1 + r)  ⇒  vat = gross * r / (1 + r)
  const vatCents = Math.round((grossCents * vatRateBps) / (10_000 + vatRateBps));
  return { netCents: grossCents - vatCents, vatCents };
}

/** Basis points of a value, half-up. Used for school commission (§2.14). */
export function bps(cents: number, basisPoints: number): number {
  return Math.round((cents * basisPoints) / 10_000);
}

export interface LineInput {
  unitCents: number;
  quantity: number;
  vatRateBps: number;
}

export interface OrderTotals {
  subtotalCents: number;
  vatCents: number;
  deliveryCents: number;
  totalCents: number;
  commissionCents: number;
}

/**
 * Total an order.
 *
 * VAT is computed per line and summed, never computed on the subtotal. Those
 * differ by up to a cent per line through rounding, and the per-line figure is
 * the one that has to appear on the invoice, so it is the one that has to be
 * authoritative.
 */
export function totalOrder(
  lines: LineInput[],
  opts: { deliveryCents?: number; deliveryVatRateBps?: number; commissionBps?: number } = {},
): OrderTotals {
  let subtotalCents = 0;
  let vatCents = 0;

  for (const l of lines) {
    const lineTotal = l.unitCents * l.quantity;
    subtotalCents += lineTotal;
    vatCents += splitVatInclusive(lineTotal, l.vatRateBps).vatCents;
  }

  const deliveryCents = opts.deliveryCents ?? 0;
  if (deliveryCents > 0) {
    vatCents += splitVatInclusive(deliveryCents, opts.deliveryVatRateBps ?? 0).vatCents;
  }

  const totalCents = subtotalCents + deliveryCents;
  return {
    subtotalCents,
    vatCents,
    deliveryCents,
    totalCents,
    // The school's cut is on goods, not on delivery — the studio does not
    // fundraise on courier fees.
    commissionCents: bps(subtotalCents, opts.commissionBps ?? 0),
  };
}

/**
 * What a package saves against buying the same items individually.
 *
 * This number does the selling (§9), which means it must be honest. If the
 * package is not actually cheaper, the function returns zero rather than a
 * negative, and the UI shows nothing rather than "saves -R20".
 */
export function packageSaving(packageCents: number, itemsIndividuallyCents: number): number {
  return Math.max(0, itemsIndividuallyCents - packageCents);
}

// ── Crop geometry (§2.10) ───────────────────────────────────────────────────

export interface Rect {
  /** All values are fractions of the source, so they survive re-derivation. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PrintSize {
  label: string;
  widthMm: number;
  heightMm: number;
  minDpi: number;
}

export const ASPECT = (s: PrintSize): number =>
  Math.max(s.widthMm, s.heightMm) / Math.min(s.widthMm, s.heightMm);

/**
 * The default crop for a source in a given print size.
 *
 * A frame shot 3:2 and printed to A4 loses about 5.7% of its long dimension.
 * Taken from the geometric centre, that crop comes off the top and bottom
 * equally — and the top is where the top of a child's head is. Parents notice;
 * labs charge for the reprint.
 *
 * So the vertical crop is biased upward: two thirds of what has to go comes off
 * the bottom. Portraits are composed with the subject in the upper half, and
 * losing shoulder is always better than losing scalp.
 */
export function defaultCrop(
  source: { width: number; height: number },
  size: PrintSize,
  headroomBias = 2 / 3,
): Rect {
  const srcAspect = source.width / source.height;
  // Match the print's orientation to the source's, so a portrait frame gets
  // portrait A4 rather than being rotated into landscape.
  const longOverShort = ASPECT(size);
  const target = srcAspect >= 1 ? longOverShort : 1 / longOverShort;

  if (Math.abs(srcAspect - target) < 1e-6) return { x: 0, y: 0, w: 1, h: 1 };

  if (srcAspect > target) {
    // Source is too wide: trim the sides, evenly. Horizontal composition is
    // usually centred, so there is no reason to prefer one side.
    const w = target / srcAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }

  // Source is too tall: trim top and bottom, biased toward the bottom.
  const h = srcAspect / target;
  const surplus = 1 - h;
  return { x: 0, y: surplus * (1 - headroomBias), w: 1, h };
}

/** Resulting pixel dimensions of a crop. */
export function croppedPixels(
  source: { width: number; height: number },
  crop: Rect,
): { width: number; height: number } {
  return {
    width: Math.round(source.width * crop.w),
    height: Math.round(source.height * crop.h),
  };
}

export interface DpiCheck {
  dpi: number;
  ok: boolean;
  /** Plain language for the parent, before they buy — not after (§11.5). */
  warning: string | null;
}

/**
 * Will this crop print acceptably at this size?
 *
 * Told to the parent at the point of choosing, in plain words. The alternative
 * is a refund request and a reprint, which costs more than the sale.
 */
export function checkDpi(
  source: { width: number; height: number },
  crop: Rect,
  size: PrintSize,
): DpiCheck {
  const px = croppedPixels(source, crop);
  const longPx = Math.max(px.width, px.height);
  const longMm = Math.max(size.widthMm, size.heightMm);
  const dpi = Math.floor(longPx / (longMm / 25.4));

  if (dpi >= size.minDpi) return { dpi, ok: true, warning: null };
  if (dpi >= size.minDpi * 0.66) {
    return {
      dpi,
      ok: true,
      warning: `At ${size.label} this will print at ${dpi} dpi. Still good, but a little softer than a full-size print.`,
    };
  }
  return {
    dpi,
    ok: false,
    warning: `This crop is too small for ${size.label} — it would print at ${dpi} dpi and look noticeably soft. Try a smaller size or a wider crop.`,
  };
}

/** Clamp a user-dragged crop so it stays inside the frame and keeps its shape. */
export function clampCrop(crop: Rect): Rect {
  const w = Math.min(1, Math.max(0.05, crop.w));
  const h = Math.min(1, Math.max(0.05, crop.h));
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, crop.x)),
    y: Math.min(1 - h, Math.max(0, crop.y)),
  };
}

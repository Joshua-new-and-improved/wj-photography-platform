/**
 * Slate-card segmentation.
 *
 * The photographer shoots a printed barcode card, then that child's frames,
 * then the next card. On import, frames are ordered by capture time and every
 * frame between slate n and slate n+1 belongs to child n.
 *
 * This is what replaces facial recognition (architecture §2.9, §7.3). It is
 * lawful without a Regulator application, needs no biometric data, is
 * deterministic rather than probabilistic, and — the property that matters most
 * in production — **fails visibly**. A probabilistic matcher that is 97%
 * accurate silently puts six hundred photographs in the wrong gallery per year
 * and nobody finds out until a parent does. This one produces a review queue.
 *
 * Everything here is a pure function so it can be tested exhaustively without
 * a database, and so a disputed assignment can be replayed from the stored
 * frame metadata months later.
 */

export interface Frame {
  assetId: string;
  /** EXIF capture time. Null happens, and is itself a review condition. */
  capturedAt: Date | null;
  /** Camera frame counter, used as a tiebreaker and as a fallback ordering. */
  frameSeq: number | null;
  /** Decoded slate barcode, if this frame is a slate. */
  slateCode: string | null;
}

export interface SegmentOptions {
  /** Child codes known for this shoot. A slate outside this set is an error. */
  knownCodes: ReadonlySet<string>;
  /** Above this, a segment probably means a missed slate. */
  maxFramesPerChild?: number;
  /** A gap this long inside one child's frames suggests a missed slate. */
  maxGapSeconds?: number;
}

export type ReviewKind =
  | "no_slates_found"
  | "frames_before_first_slate"
  | "empty_segment"
  | "oversized_segment"
  | "unknown_slate_code"
  | "duplicate_slate"
  | "suspicious_gap"
  | "missing_capture_time"
  | "unordered_frames";

export interface ReviewItem {
  kind: ReviewKind;
  /** Frames the photographer needs to look at. */
  assetIds: string[];
  slateCode?: string;
  detail: string;
}

export interface Assignment {
  assetId: string;
  childCode: string;
  /** 1.0 for a clean segment; reduced when something about it is odd. */
  confidence: number;
}

export interface SegmentResult {
  assignments: Assignment[];
  /** Slate frames themselves. Never enter a gallery; usually deleted later. */
  slateAssetIds: string[];
  /** Frames that could not be attributed. Go to the manual tagging queue. */
  unassignedAssetIds: string[];
  reviews: ReviewItem[];
  /** True when every frame was attributed with full confidence. */
  clean: boolean;
}

const DEFAULTS = { maxFramesPerChild: 25, maxGapSeconds: 240 };

/**
 * Order frames for segmentation.
 *
 * Capture time is authoritative because it is what the segmentation logic
 * means. Frame sequence is the tiebreaker for burst shots recorded in the same
 * second — without it, a three-frame burst can order arbitrarily and a slate
 * can end up *after* the first frame of the child it introduces.
 */
function orderFrames(frames: Frame[]): { ordered: Frame[]; missingTime: Frame[] } {
  const missingTime = frames.filter((f) => f.capturedAt === null);
  const ordered = [...frames].sort((a, b) => {
    const ta = a.capturedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const tb = b.capturedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return (a.frameSeq ?? 0) - (b.frameSeq ?? 0);
  });
  return { ordered, missingTime };
}

export function segmentBySlates(frames: Frame[], opts: SegmentOptions): SegmentResult {
  const maxFrames = opts.maxFramesPerChild ?? DEFAULTS.maxFramesPerChild;
  const maxGapMs = (opts.maxGapSeconds ?? DEFAULTS.maxGapSeconds) * 1000;

  const assignments: Assignment[] = [];
  const slateAssetIds: string[] = [];
  const unassignedAssetIds: string[] = [];
  const reviews: ReviewItem[] = [];

  const { ordered, missingTime } = orderFrames(frames);

  if (missingTime.length > 0) {
    reviews.push({
      kind: "missing_capture_time",
      assetIds: missingTime.map((f) => f.assetId),
      detail:
        `${missingTime.length} frame(s) have no EXIF capture time and cannot be ` +
        `placed in the sequence. Assign these manually.`,
    });
  }

  const slateIndexes = ordered
    .map((f, i) => (f.slateCode ? i : -1))
    .filter((i) => i >= 0);

  if (slateIndexes.length === 0) {
    reviews.push({
      kind: "no_slates_found",
      assetIds: [],
      detail:
        "No slate cards were decoded in this batch. Falling back to manual " +
        "tagging. If cards were used, check that they were shot in focus and " +
        "filled enough of the frame to decode.",
    });
    return {
      assignments: [],
      slateAssetIds: [],
      unassignedAssetIds: ordered.map((f) => f.assetId),
      reviews,
      clean: false,
    };
  }

  // Frames shot before the first card. Usually test shots, a grey card, or the
  // photographer warming up. Occasionally the first child, whose card was
  // missed — which is why these are surfaced rather than dropped.
  const firstSlate = slateIndexes[0]!;
  if (firstSlate > 0) {
    const orphans = ordered.slice(0, firstSlate);
    unassignedAssetIds.push(...orphans.map((f) => f.assetId));
    reviews.push({
      kind: "frames_before_first_slate",
      assetIds: orphans.map((f) => f.assetId),
      detail:
        `${orphans.length} frame(s) were shot before the first slate card. ` +
        `These are usually test shots, but check whether the first child's ` +
        `card was missed.`,
    });
  }

  const seenCodes = new Map<string, number>();

  for (let s = 0; s < slateIndexes.length; s++) {
    const slateIdx = slateIndexes[s]!;
    const slate = ordered[slateIdx]!;
    const code = slate.slateCode!;
    slateAssetIds.push(slate.assetId);

    const end = s + 1 < slateIndexes.length ? slateIndexes[s + 1]! : ordered.length;
    const segment = ordered.slice(slateIdx + 1, end);

    // A code the roster does not contain. Either the card belongs to another
    // school, or the class list changed after cards were printed. Never guess.
    if (!opts.knownCodes.has(code)) {
      unassignedAssetIds.push(...segment.map((f) => f.assetId));
      reviews.push({
        kind: "unknown_slate_code",
        slateCode: code,
        assetIds: segment.map((f) => f.assetId),
        detail:
          `Slate code "${code}" is not in this shoot's class list. ` +
          `${segment.length} frame(s) are unassigned.`,
      });
      continue;
    }

    if (segment.length === 0) {
      reviews.push({
        kind: "empty_segment",
        slateCode: code,
        assetIds: [slate.assetId],
        detail:
          `A card was shot for "${code}" but no photographs followed. ` +
          `Usually means the child left before the shot — check the absentee list.`,
      });
      continue;
    }

    let confidence = 1;

    if (segment.length > maxFrames) {
      confidence = 0.5;
      reviews.push({
        kind: "oversized_segment",
        slateCode: code,
        assetIds: segment.map((f) => f.assetId),
        detail:
          `${segment.length} frames attributed to "${code}", above the ` +
          `expected maximum of ${maxFrames}. A slate card was probably missed, ` +
          `which would put the next child's photographs in this gallery.`,
      });
    }

    // A long pause inside one child's frames is the signature of a missed card.
    const gap = largestGap(segment);
    if (gap && gap.ms > maxGapMs) {
      confidence = Math.min(confidence, 0.6);
      reviews.push({
        kind: "suspicious_gap",
        slateCode: code,
        assetIds: [gap.beforeAssetId, gap.afterAssetId],
        detail:
          `A ${Math.round(gap.ms / 1000)}s pause occurs inside "${code}"'s ` +
          `frames. Check whether a card was missed at that point.`,
      });
    }

    // The same child photographed again later — a retake in the same session.
    // Legitimate, and correct to merge, but worth a look.
    const previous = seenCodes.get(code);
    if (previous !== undefined && previous !== s - 1) {
      confidence = Math.min(confidence, 0.8);
      reviews.push({
        kind: "duplicate_slate",
        slateCode: code,
        assetIds: segment.map((f) => f.assetId),
        detail:
          `"${code}" appears at two separate points in the sequence. Frames ` +
          `from both have been merged into one gallery — confirm this is a retake.`,
      });
    }
    seenCodes.set(code, s);

    for (const f of segment) {
      assignments.push({ assetId: f.assetId, childCode: code, confidence });
    }
  }

  // A duplicate is only discoverable on its second occurrence, but the
  // ambiguity it raises applies to the child's whole gallery — the question
  // "are these really the same child?" is not answered differently for the
  // earlier frames. So downgrade every assignment for an affected code, not
  // just the ones that happened to come after the discovery.
  const duplicated = new Set(
    reviews.filter((r) => r.kind === "duplicate_slate").map((r) => r.slateCode!),
  );
  if (duplicated.size > 0) {
    for (const a of assignments) {
      if (duplicated.has(a.childCode)) a.confidence = Math.min(a.confidence, 0.8);
    }
  }

  return {
    assignments,
    slateAssetIds,
    unassignedAssetIds,
    reviews,
    clean: reviews.length === 0 && unassignedAssetIds.length === 0,
  };
}

function largestGap(
  segment: Frame[],
): { ms: number; beforeAssetId: string; afterAssetId: string } | null {
  let worst: { ms: number; beforeAssetId: string; afterAssetId: string } | null = null;
  for (let i = 1; i < segment.length; i++) {
    const a = segment[i - 1]!;
    const b = segment[i]!;
    if (!a.capturedAt || !b.capturedAt) continue;
    const ms = b.capturedAt.getTime() - a.capturedAt.getTime();
    if (!worst || ms > worst.ms) {
      worst = { ms, beforeAssetId: a.assetId, afterAssetId: b.assetId };
    }
  }
  return worst;
}

/**
 * Summarise a result for the review screen.
 *
 * The screen shows problems first and says nothing about the frames that
 * worked. On a clean 400-child import that means an empty list, which is the
 * correct amount of attention to demand.
 */
export function reviewSummary(result: SegmentResult): {
  assigned: number;
  needsReview: number;
  children: number;
  headline: string;
} {
  const children = new Set(result.assignments.map((a) => a.childCode)).size;
  const needsReview =
    result.unassignedAssetIds.length +
    result.assignments.filter((a) => a.confidence < 1).length;

  return {
    assigned: result.assignments.length,
    needsReview,
    children,
    headline: result.clean
      ? `${result.assignments.length} photographs matched to ${children} children. Nothing needs review.`
      : `${result.assignments.length} photographs matched to ${children} children. ` +
        `${needsReview} need a look.`,
  };
}

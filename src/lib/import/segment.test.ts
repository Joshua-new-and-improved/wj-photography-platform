import { describe, it, expect } from "vitest";
import { segmentBySlates, reviewSummary, type Frame } from "./segment.js";

/** Build a frame sequence tersely. `t` is seconds from an arbitrary origin. */
const T0 = new Date("2026-08-01T08:00:00Z").getTime();
let seq = 0;
function frame(t: number, slateCode: string | null = null): Frame {
  seq++;
  return {
    assetId: `a${seq}`,
    capturedAt: new Date(T0 + t * 1000),
    frameSeq: seq,
    slateCode,
  };
}
function reset() {
  seq = 0;
}

const roster = new Set(["LL001", "LL002", "LL003"]);

describe("the happy path", () => {
  it("attributes each child's frames to their own card", () => {
    reset();
    const frames = [
      frame(0, "LL001"),
      frame(5),
      frame(8),
      frame(11),
      frame(20, "LL002"),
      frame(25),
      frame(28),
      frame(40, "LL003"),
      frame(45),
    ];

    const r = segmentBySlates(frames, { knownCodes: roster });

    expect(r.clean).toBe(true);
    expect(r.slateAssetIds).toHaveLength(3);
    expect(r.assignments).toHaveLength(6);
    expect(r.assignments.filter((a) => a.childCode === "LL001")).toHaveLength(3);
    expect(r.assignments.filter((a) => a.childCode === "LL002")).toHaveLength(2);
    expect(r.assignments.filter((a) => a.childCode === "LL003")).toHaveLength(1);
    expect(r.assignments.every((a) => a.confidence === 1)).toBe(true);
    // The card itself never reaches a gallery.
    expect(r.assignments.map((a) => a.assetId)).not.toContain("a1");
  });

  it("orders a burst correctly using the frame counter", () => {
    reset();
    // Three frames recorded in the same second. Without the frameSeq
    // tiebreaker these can order arbitrarily, and the slate can end up after
    // the first frame of the child it introduces.
    const frames = [frame(10), frame(10), frame(10), frame(10, "LL001")];
    // Shuffle to prove the sort does the work, not the input order.
    const shuffled = [frames[2]!, frames[0]!, frames[3]!, frames[1]!];
    const r = segmentBySlates(shuffled, { knownCodes: roster });
    // The slate has the highest frameSeq, so nothing follows it.
    expect(r.reviews.map((x) => x.kind)).toContain("frames_before_first_slate");
    expect(r.reviews.map((x) => x.kind)).toContain("empty_segment");
  });
});

describe("failure modes that actually happen on shoot day", () => {
  it("flags a missed card via an oversized segment", () => {
    reset();
    // The assistant forgot to hand child two their card, so two children's
    // frames land under one code. This is the failure that matters most,
    // because the photographs end up in the wrong parent's gallery.
    const frames = [frame(0, "LL001"), ...Array.from({ length: 30 }, (_, i) => frame(5 + i))];
    const r = segmentBySlates(frames, { knownCodes: roster });

    expect(r.clean).toBe(false);
    expect(r.reviews.map((x) => x.kind)).toContain("oversized_segment");
    // Still assigned, but at reduced confidence so the review UI surfaces it.
    expect(r.assignments.every((a) => a.confidence < 1)).toBe(true);
  });

  it("flags a long pause inside one child's frames", () => {
    reset();
    const frames = [
      frame(0, "LL001"),
      frame(5),
      frame(8),
      // Five minutes later — the photographer almost certainly moved on to
      // another child without a card.
      frame(320),
      frame(325),
    ];
    const r = segmentBySlates(frames, { knownCodes: roster, maxGapSeconds: 240 });
    expect(r.reviews.map((x) => x.kind)).toContain("suspicious_gap");
  });

  it("flags a card shot with no photographs after it", () => {
    reset();
    // Child handed the card and then bolted. Correlates with the absentee list.
    const frames = [frame(0, "LL001"), frame(10, "LL002"), frame(15), frame(18)];
    const r = segmentBySlates(frames, { knownCodes: roster });

    const empty = r.reviews.find((x) => x.kind === "empty_segment");
    expect(empty?.slateCode).toBe("LL001");
    expect(r.assignments.every((a) => a.childCode === "LL002")).toBe(true);
  });

  it("refuses to guess at a code outside the class list", () => {
    reset();
    // A card from another school, or a class list that changed after printing.
    const frames = [frame(0, "ZZ999"), frame(5), frame(8), frame(20, "LL001"), frame(25)];
    const r = segmentBySlates(frames, { knownCodes: roster });

    expect(r.reviews.find((x) => x.kind === "unknown_slate_code")?.slateCode).toBe("ZZ999");
    expect(r.unassignedAssetIds).toHaveLength(2);
    expect(r.assignments.every((a) => a.childCode === "LL001")).toBe(true);
  });

  it("merges a legitimate same-session retake but asks for confirmation", () => {
    reset();
    const frames = [
      frame(0, "LL001"),
      frame(5),
      frame(20, "LL002"),
      frame(25),
      // Child one comes back at the end because the first set was blinked.
      frame(200, "LL001"),
      frame(205),
    ];
    const r = segmentBySlates(frames, { knownCodes: roster });

    expect(r.assignments.filter((a) => a.childCode === "LL001")).toHaveLength(2);
    expect(r.reviews.map((x) => x.kind)).toContain("duplicate_slate");
    expect(
      r.assignments.filter((a) => a.childCode === "LL001").every((a) => a.confidence < 1),
    ).toBe(true);
  });

  it("does not flag consecutive slates for the same child as a duplicate", () => {
    reset();
    // Two cards shot back to back — the photographer re-shot the card because
    // the first looked out of focus. Not a retake, not worth a review item.
    const frames = [frame(0, "LL001"), frame(2, "LL001"), frame(6), frame(9)];
    const r = segmentBySlates(frames, { knownCodes: roster });
    expect(r.reviews.map((x) => x.kind)).not.toContain("duplicate_slate");
  });

  it("surfaces frames with no capture time rather than dropping them", () => {
    reset();
    const frames: Frame[] = [
      frame(0, "LL001"),
      frame(5),
      { assetId: "no-exif", capturedAt: null, frameSeq: null, slateCode: null },
    ];
    const r = segmentBySlates(frames, { knownCodes: roster });
    const item = r.reviews.find((x) => x.kind === "missing_capture_time");
    expect(item?.assetIds).toContain("no-exif");
  });

  it("falls back cleanly when no cards were used at all", () => {
    reset();
    const frames = [frame(0), frame(5), frame(10)];
    const r = segmentBySlates(frames, { knownCodes: roster });

    expect(r.reviews.map((x) => x.kind)).toContain("no_slates_found");
    expect(r.assignments).toHaveLength(0);
    // Every frame goes to the manual tagging queue — degraded, not broken.
    expect(r.unassignedAssetIds).toHaveLength(3);
  });
});

describe("review summary", () => {
  it("says nothing needs attention when nothing does", () => {
    reset();
    const frames = [frame(0, "LL001"), frame(5), frame(20, "LL002"), frame(25)];
    const s = reviewSummary(segmentBySlates(frames, { knownCodes: roster }));
    expect(s.children).toBe(2);
    expect(s.needsReview).toBe(0);
    expect(s.headline).toContain("Nothing needs review");
  });

  it("scales to a full class", () => {
    reset();
    // 30 children, 6 frames each: the realistic shape of one class.
    const frames: Frame[] = [];
    const codes = new Set<string>();
    let t = 0;
    for (let c = 1; c <= 30; c++) {
      const code = `LL${String(c).padStart(3, "0")}`;
      codes.add(code);
      frames.push(frame(t, code));
      t += 3;
      for (let i = 0; i < 6; i++) {
        frames.push(frame(t));
        t += 4;
      }
      t += 6;
    }
    const r = segmentBySlates(frames, { knownCodes: codes });
    expect(r.assignments).toHaveLength(180);
    expect(r.clean).toBe(true);
    expect(reviewSummary(r).children).toBe(30);
  });
});

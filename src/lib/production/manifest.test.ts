import { describe, it, expect } from "vitest";
import {
  planPrintRuns, buildPackingManifest, deliveryReadiness, gradeRank,
  type PrintJob,
} from "./manifest.js";

let n = 0;
function job(p: Partial<PrintJob> = {}): PrintJob {
  n++;
  return {
    id: "j" + n, orderId: "o" + n, orderNumber: "WJ-000" + n,
    childId: "c" + n, childFirstName: "Kind", childLastName: "Van Zyl" + n,
    gradeName: "Grade R", gradeLevel: "R", className: "A",
    assetRef: "03A-01", sizeLabel: "A4", finish: "gloss",
    quantity: 1, status: "queued", ...p,
  };
}

describe("print runs", () => {
  it("groups by paper so the printer loads each size once", () => {
    n = 0;
    const runs = planPrintRuns([
      job({ sizeLabel: "A4", quantity: 2 }),
      job({ sizeLabel: "10×15", quantity: 5 }),
      job({ sizeLabel: "A4", quantity: 3 }),
      job({ sizeLabel: "10×15", quantity: 4 }),
    ]);
    expect(runs).toHaveLength(2);
    // Longest run first: the biggest chunk is done before anything goes wrong.
    expect(runs[0]!.sizeLabel).toBe("10×15");
    expect(runs[0]!.sheets).toBe(9);
    expect(runs[1]!.sheets).toBe(5);
  });

  it("treats a different finish as different media", () => {
    n = 0;
    const runs = planPrintRuns([
      job({ sizeLabel: "A4", finish: "gloss" }),
      job({ sizeLabel: "A4", finish: "matt" }),
    ]);
    // Same size, but the printer still has to be reloaded.
    expect(runs).toHaveLength(2);
  });

  it("counts sheets, not jobs", () => {
    n = 0;
    const runs = planPrintRuns([job({ quantity: 6 })]);
    expect(runs[0]!.jobs).toHaveLength(1);
    expect(runs[0]!.sheets).toBe(6);
  });

  it("never reprints a superseded job", () => {
    // The commonest way this goes wrong is planning from "everything in the
    // batch" instead of "everything still outstanding".
    n = 0;
    const runs = planPrintRuns([
      job({ status: "superseded", quantity: 3 }),
      job({ status: "printed", quantity: 3 }),
      job({ status: "queued", quantity: 1 }),
      job({ status: "reprint_needed", quantity: 1 }),
    ]);
    expect(runs.reduce((s, r) => s + r.sheets, 0)).toBe(2);
  });

  it("orders within a run by class so the output tray comes off sorted", () => {
    n = 0;
    const runs = planPrintRuns([
      job({ gradeLevel: "3", gradeName: "Grade 3", className: "B" }),
      job({ gradeLevel: "R", gradeName: "Grade R", className: "A" }),
      job({ gradeLevel: "RR", gradeName: "Grade RR", className: "A" }),
    ]);
    expect(runs[0]!.jobs.map((j) => j.gradeLevel)).toEqual(["RR", "R", "3"]);
  });
});

describe("packing manifest", () => {
  it("gives a child ONE envelope even across two orders", () => {
    // A package on Monday and an extra A4 on Thursday is one envelope, because
    // that is what a teacher hands over.
    n = 0;
    const m = buildPackingManifest([
      job({ childId: "kid", orderNumber: "WJ-0001", status: "printed", quantity: 2 }),
      job({ childId: "kid", orderNumber: "WJ-0002", status: "printed", quantity: 1,
            sizeLabel: "A4" }),
    ]);
    expect(m.totalEnvelopes).toBe(1);
    const env = m.classes[0]!.envelopes[0]!;
    expect(env.totalPrints).toBe(3);
    // Both order numbers printed on it, so a query can be traced back.
    expect(env.orderNumbers).toEqual(["WJ-0001", "WJ-0002"]);
  });

  it("sorts classes the way the school office sorts boxes", () => {
    n = 0;
    const m = buildPackingManifest([
      job({ gradeLevel: "10", gradeName: "Grade 10", status: "printed" }),
      job({ gradeLevel: "2", gradeName: "Grade 2", status: "printed" }),
      job({ gradeLevel: "R", gradeName: "Grade R", status: "printed" }),
      job({ gradeLevel: "RR", gradeName: "Grade RR", status: "printed" }),
    ]);
    expect(m.classes.map((c) => c.gradeName)).toEqual([
      "Grade RR", "Grade R", "Grade 2", "Grade 10",
    ]);
  });

  it("sorts children alphabetically, the way a class list reads", () => {
    n = 0;
    const m = buildPackingManifest([
      job({ childId: "a", childFirstName: "Zané", childLastName: "Wessels", status: "printed" }),
      job({ childId: "b", childFirstName: "Anke", childLastName: "Botha", status: "printed" }),
    ]);
    expect(m.classes[0]!.envelopes.map((e) => e.childName)).toEqual([
      "Anke Botha", "Zané Wessels",
    ]);
  });

  it("does not pack anything still queued, and says so", () => {
    n = 0;
    const m = buildPackingManifest([
      job({ status: "printed" }),
      job({ status: "queued" }),
    ]);
    expect(m.totalEnvelopes).toBe(1);
    expect(m.outstanding).toHaveLength(1);
  });
});

describe("delivery readiness", () => {
  it("blocks a delivery that would arrive one envelope short", () => {
    // Better to hold the whole delivery than to send it incomplete: an
    // incomplete delivery is a phone call, a special trip, and a parent who
    // tells other parents.
    n = 0;
    const r = deliveryReadiness([job({ status: "printed" }), job({ status: "queued" })]);
    expect(r.ready).toBe(false);
    expect(r.blocking[0]).toContain("queued");
  });

  it("blocks on an outstanding reprint", () => {
    n = 0;
    const r = deliveryReadiness([job({ status: "reprint_needed" })]);
    expect(r.ready).toBe(false);
  });

  it("clears when everything is printed", () => {
    n = 0;
    const r = deliveryReadiness([
      job({ status: "printed" }),
      job({ status: "superseded" }),
      job({ status: "packed" }),
    ]);
    expect(r.ready).toBe(true);
    expect(r.blocking).toEqual([]);
  });
});

describe("grade ordering", () => {
  it("puts the reception years before Grade 1", () => {
    expect(gradeRank("RR")).toBeLessThan(gradeRank("R"));
    expect(gradeRank("R")).toBeLessThan(gradeRank("1"));
    expect(gradeRank("2")).toBeLessThan(gradeRank("10"));
  });
});

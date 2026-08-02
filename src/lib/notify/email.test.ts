import { describe, it, expect } from "vitest";
import { checkEmail, planOrderEmails, type OrderMailContext } from "./email.js";

describe("obviously broken addresses", () => {
  it("rejects the shapes people actually mistype", () => {
    for (const bad of ["", "noah", "noah@", "@gmail.com", "noah gmail.com", "noah@gmail"]) {
      const r = checkEmail(bad);
      expect(r.valid, bad).toBe(false);
      expect(r.message, bad).not.toBeNull();
    }
  });

  it("normalises case and stray spaces rather than rejecting them", () => {
    // A parent typing on a phone gets a leading space and an autocapitalised
    // first letter. That is not an error worth showing anyone.
    expect(checkEmail("  Noah.Botha@Gmail.com ").normalised).toBe("noah.botha@gmail.com");
    expect(checkEmail("  Noah.Botha@Gmail.com ").valid).toBe(true);
  });
});

describe("plausible but wrong — the ones that cost money", () => {
  it("catches the classic global typos", () => {
    expect(checkEmail("noah@gmial.com").suggestion).toBe("noah@gmail.com");
    expect(checkEmail("noah@hotmial.com").suggestion).toBe("noah@hotmail.com");
    expect(checkEmail("noah@outlok.com").suggestion).toBe("noah@outlook.com");
  });

  it("catches South African domains a generic checker would miss", () => {
    // This is most of the point. A typo checker built for a US audience has
    // never heard of telkomsa.net.
    expect(checkEmail("noah@telkomsa.ne").suggestion).toBe("noah@telkomsa.net");
    expect(checkEmail("noah@webmail.co.z").suggestion).toBe("noah@webmail.co.za");
    expect(checkEmail("noah@mweb.co.zaa").suggestion).toBe("noah@mweb.co.za");
  });

  it("still treats a typo'd address as valid, because it is", () => {
    // It must not block checkout. The parent gets a question, not an error.
    const r = checkEmail("noah@gmial.com");
    expect(r.valid).toBe(true);
    expect(r.message).toContain("Did you mean");
  });

  it("does NOT try to correct a genuinely unusual domain", () => {
    // Three or more edits away is somebody's company domain, and "correcting"
    // it is worse than saying nothing.
    expect(checkEmail("noah@plutusmarketing.co.za").suggestion).toBeNull();
    expect(checkEmail("noah@up.ac.za").suggestion).toBeNull();
  });

  it("leaves a correct address completely alone", () => {
    const r = checkEmail("noah.botha@gmail.com");
    expect(r.valid).toBe(true);
    expect(r.suggestion).toBeNull();
    expect(r.message).toBeNull();
  });
});

describe("shared office addresses", () => {
  it("warns when a parent enters the school office address", () => {
    // It happens: a parent hands the form to the secretary, who fills in theirs.
    // Photographs then arrive in a shared inbox.
    const r = checkEmail("admin@webmail.co.za");
    expect(r.isRoleAddress).toBe(true);
    expect(r.message).toContain("shared office address");
    expect(r.valid).toBe(true); // warn, never block
  });
});

const NOW = new Date("2026-08-20T10:00:00Z");
const base: OrderMailContext = {
  orderId: "o1", orderNumber: "WJ-1001", guardianId: "g1",
  toEmail: "parent@test.test",
  hasDigitalLines: false, hasPhysicalLines: false, paymentSettled: true,
  digitalRelease: "on_payment",
  orderDeadlineAt: new Date("2026-08-27T12:00:00Z"),
  physicalDispatchAt: null,
};

describe("what an order sends", () => {
  it("sends nothing until payment settles", () => {
    expect(planOrderEmails(NOW, { ...base, paymentSettled: false })).toHaveLength(0);
  });

  it("always sends a receipt", () => {
    const m = planOrderEmails(NOW, base);
    expect(m.map((x) => x.templateKey)).toEqual(["order.paid"]);
  });

  it("releases digital photographs the moment payment settles", () => {
    const m = planOrderEmails(NOW, { ...base, hasDigitalLines: true });
    const dl = m.find((x) => x.templateKey === "digital.ready")!;
    expect(dl.scheduledFor.getTime()).toBe(NOW.getTime());
    expect(dl.includesDownloads).toBe(true);
  });

  it("honours a studio that holds digitals until the deadline", () => {
    const m = planOrderEmails(NOW, {
      ...base, hasDigitalLines: true, digitalRelease: "on_deadline",
    });
    // The receipt still goes today — only the download waits.
    expect(m.find((x) => x.templateKey === "order.paid")!.scheduledFor).toEqual(NOW);
    expect(m.find((x) => x.templateKey === "digital.ready")!.scheduledFor)
      .toEqual(base.orderDeadlineAt);
  });

  it("queues no download mail at all under manual release", () => {
    const m = planOrderEmails(NOW, {
      ...base, hasDigitalLines: true, digitalRelease: "manual",
    });
    expect(m.some((x) => x.includesDownloads)).toBe(false);
  });

  it("tells the parent about prints the same day, dated or not", () => {
    // Silence reads worse than an approximate answer.
    const undated = planOrderEmails(NOW, { ...base, hasPhysicalLines: true });
    expect(undated.map((x) => x.templateKey)).toContain("physical.pending");

    const dated = planOrderEmails(NOW, {
      ...base, hasPhysicalLines: true,
      physicalDispatchAt: new Date("2026-09-10T08:00:00Z"),
    });
    expect(dated.map((x) => x.templateKey)).toContain("physical.scheduled");
  });

  it("handles a mixed order on both clocks at once", () => {
    const m = planOrderEmails(NOW, {
      ...base, hasDigitalLines: true, hasPhysicalLines: true,
      physicalDispatchAt: new Date("2026-09-10T08:00:00Z"),
    });
    expect(m.map((x) => x.templateKey).sort()).toEqual([
      "digital.ready", "order.paid", "physical.scheduled",
    ]);
  });

  it("gives every message a key unique to its purpose", () => {
    // A duplicated payment webhook must not produce two thank-you emails.
    const m = planOrderEmails(NOW, {
      ...base, hasDigitalLines: true, hasPhysicalLines: true,
    });
    expect(new Set(m.map((x) => x.idempotencyKey)).size).toBe(m.length);
    expect(m.every((x) => x.idempotencyKey.includes("WJ-1001"))).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import {
  planReminders, respectQuietHours, classifyMessage, MAX_PER_SHOOT,
  type Recipient, type ShootWindow, type SentRecord,
} from "./reminders.js";

const DEADLINE = new Date("2026-08-27T12:00:00Z");
const shoot: ShootWindow = {
  shootId: "s1", schoolName: "Laerskool Louis Leipoldt",
  galleryOpensAt: new Date("2026-08-14T09:00:00Z"),
  orderDeadlineAt: DEADLINE, graceHours: 48,
};
const at = (iso: string) => new Date(iso);

let n = 0;
function rec(p: Partial<Recipient> = {}): Recipient {
  n++;
  return {
    guardianId: "g" + n, childId: "c" + n, childFirstName: "Noah",
    email: "parent" + n + "@test.test", phone: null,
    audience: "claimed_no_order", childSuppressed: false, ...p,
  };
}

describe("timing", () => {
  it("sends nothing before the first stage is due", () => {
    n = 0;
    const r = planReminders(at("2026-08-15T10:00:00Z"), shoot, [rec()], []);
    expect(r.sends).toHaveLength(0);
  });

  it("fires the 48-hour reminder, the one that works", () => {
    n = 0;
    const r = planReminders(at("2026-08-25T13:00:00Z"), shoot, [rec()], []);
    expect(r.sends.map((s) => s.stage)).toContain("final_48h");
  });

  it("stops entirely once the grace period has passed", () => {
    // A reminder about a closed gallery invites a request the studio then has
    // to refuse — worse than sending nothing.
    n = 0;
    const r = planReminders(at("2026-08-30T09:00:00Z"), shoot, [rec()], []);
    expect(r.sends).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("closed");
  });
});

describe("quiet hours", () => {
  it("never sends in the small hours", () => {
    // A notification about your child's school photographs at 03:00 is the kind
    // of thing people screenshot.
    expect(respectQuietHours(at("2026-08-25T03:00:00Z")).getUTCHours()).toBe(7);
  });
  it("pushes a late-evening send to the next morning", () => {
    const out = respectQuietHours(at("2026-08-25T22:30:00Z"));
    expect(out.getUTCHours()).toBe(7);
    expect(out.getUTCDate()).toBe(26);
  });
  it("leaves a reasonable hour alone", () => {
    const t = at("2026-08-25T14:15:00Z");
    expect(respectQuietHours(t).getTime()).toBe(t.getTime());
  });
});

describe("who gets what", () => {
  it("does not give a twelve-hour last call to someone who showed no interest", () => {
    // A last call to a browser is a nuisance; to someone with an unfinished
    // cart it is a favour.
    n = 0;
    const browsing = planReminders(at("2026-08-27T01:00:00Z"), shoot,
      [rec({ audience: "claimed_no_order" })], []);
    expect(browsing.sends.map((s) => s.stage)).not.toContain("last_call");

    n = 0;
    const holding = planReminders(at("2026-08-27T01:00:00Z"), shoot,
      [rec({ audience: "cart_abandoned", cartValueCents: 48500 })], []);
    expect(holding.sends.map((s) => s.stage)).toContain("last_call");
  });

  it("prefers email over SMS, because SMS costs real money", () => {
    n = 0;
    const withEmail = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ email: "a@b.test", phone: "+27821234567" })], []);
    expect(withEmail.sends[0]!.channel).toBe("email");

    n = 0;
    const smsOnly = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ email: null, phone: "+27821234567" })], []);
    expect(smsOnly.sends[0]!.channel).toBe("sms");
  });

  it("surfaces an unreachable recipient rather than dropping them", () => {
    n = 0;
    const r = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ email: null, phone: null })], []);
    expect(r.sends).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("no email");
  });
});

describe("hard constraints", () => {
  it("never messages about a suppressed child, at all", () => {
    // Not a neutral version, not a version without the name. Nothing.
    n = 0;
    const r = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ childSuppressed: true })], []);
    expect(r.sends).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain("suppression register");
  });

  it("respects an opt-out", () => {
    n = 0;
    const r = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ unsubscribedAt: at("2026-08-20T00:00:00Z") })], []);
    expect(r.sends).toHaveLength(0);
  });

  it("caps total messages per guardian per shoot", () => {
    n = 0;
    const who = rec({ audience: "never_claimed" });
    const sent: SentRecord[] = ["gallery_open", "one_week", "final_48h"].map((stage) => ({
      guardianId: who.guardianId, childId: who.childId,
      stage: stage as SentRecord["stage"], sentAt: at("2026-08-20T09:00:00Z"),
    }));
    expect(sent).toHaveLength(MAX_PER_SHOOT);
    const r = planReminders(at("2026-08-26T09:00:00Z"), shoot, [who], sent);
    expect(r.sends).toHaveLength(0);
  });

  it("is idempotent, so an hourly scheduler cannot spam", () => {
    // A retried job must not mean twelve copies of the same message.
    n = 0;
    const who = rec();
    const now = at("2026-08-25T13:00:00Z");
    const first = planReminders(now, shoot, [who], []);
    expect(first.sends).toHaveLength(1);

    // Record the send AND everything it superseded — which is what the
    // `supersedes` field exists to make impossible to forget.
    const sent: SentRecord[] = first.sends.flatMap((s) =>
      [s.stage, ...s.supersedes].map((stage) => ({
        guardianId: s.recipient.guardianId, childId: s.recipient.childId,
        stage, sentAt: now,
      })),
    );
    for (let i = 0; i < 12; i++) {
      expect(planReminders(now, shoot, [who], sent).sends).toHaveLength(0);
    }
  });
});

describe("POPIA s69 classification", () => {
  it("treats a deadline reminder as a service message", () => {
    // A reminder that a gallery the parent holds a code for is closing is about
    // a thing they already have.
    expect(classifyMessage("final_48h.claimed_no_order.email")).toBe("service");
    expect(classifyMessage("gallery_open.never_claimed.sms")).toBe("service");
  });

  it("treats anything else as marketing, needing its own opt-in", () => {
    // "Book your family portrait session" to the same list is a different thing
    // in law, and getting it wrong is what turns a school contract into a
    // complaint to the Information Regulator.
    expect(classifyMessage("family_session_promo.claimed_no_order.email")).toBe("marketing");
  });
});

describe("catching up after downtime", () => {
  it("sends only the most recent stage, not every stage that came due", () => {
    // If the scheduler is down for a day, several stages fall due at once.
    // Firing them all means "one week left" and "48 hours left" arrive in the
    // same minute, which reads as a malfunction.
    n = 0;
    const r = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ audience: "never_claimed" })], []);
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]!.stage).toBe("final_48h");
    expect(r.skipped.some((s) => s.reason.includes("superseded"))).toBe(true);
  });

  it("returns superseded stages so they cannot fire an hour later", () => {
    n = 0;
    const r = planReminders(at("2026-08-25T13:00:00Z"), shoot,
      [rec({ audience: "never_claimed" })], []);
    expect(r.sends[0]!.supersedes).toContain("one_week");
  });
});

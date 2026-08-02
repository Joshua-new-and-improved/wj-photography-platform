/**
 * Deadline reminders.
 *
 * A large share of orders arrive in the last 48 hours before the cut-off. That
 * is not a quirk — a slip goes home in a schoolbag, gets put on the fridge, and
 * is remembered when something prompts it. The reminder is the prompt, and it
 * is probably the highest-value thing in Phase 6.
 *
 * It is also the easiest thing in the product to get wrong in a way that ends
 * with a complaint to the school. So the planner is a pure function with hard
 * constraints, and every constraint below exists because the alternative is a
 * parent who feels harassed about photographs of their child.
 */

export type Audience =
  | "never_claimed"    // slip issued, gallery never opened
  | "claimed_no_order" // looked, did not buy
  | "cart_abandoned";  // built a cart, did not check out

export type Channel = "email" | "sms" | "whatsapp";

export interface Recipient {
  guardianId: string | null;
  childId: string;
  childFirstName: string;
  email: string | null;
  phone: string | null;
  audience: Audience;
  /** Set for cart_abandoned. Drives the copy and the urgency. */
  cartValueCents?: number;
  /** A suppressed child is never messaged about, at all (§2.4). */
  childSuppressed: boolean;
  /** Hard opt-out. Separate from marketing consent. */
  unsubscribedAt?: Date | null;
}

export interface ShootWindow {
  shootId: string;
  schoolName: string;
  galleryOpensAt: Date;
  orderDeadlineAt: Date;
  graceHours: number;
}

export interface SentRecord {
  guardianId: string | null;
  childId: string;
  stage: ReminderStage;
  sentAt: Date;
}

export type ReminderStage =
  | "gallery_open"   // +2 days after opening: "your photographs are ready"
  | "one_week"       // 7 days out
  | "final_48h"      // the one that works
  | "last_call";     // 12 hours out, cart holders only

export interface PlannedSend {
  recipient: Recipient;
  stage: ReminderStage;
  channel: Channel;
  sendAt: Date;
  /** Which copy template. Kept as an id so wording is versioned, not inlined. */
  template: string;
  /**
   * Stages that fell due at the same time and were skipped in favour of this
   * one. The caller MUST record these as sent alongside the send itself.
   *
   * Without that, they are still "outstanding" on the next run and fire an hour
   * later — which is exactly the drip of stale messages this was meant to
   * prevent. Returning them explicitly rather than swallowing them means the
   * persistence step cannot quietly forget.
   */
  supersedes: ReminderStage[];
}

/** Never send outside these hours, in the school's local time. */
export const QUIET_HOURS = { startHour: 7, endHour: 20 };

/** Hard cap per guardian per shoot, across all stages. */
export const MAX_PER_SHOOT = 3;

const STAGE_OFFSETS: Array<{ stage: ReminderStage; hoursBeforeDeadline: number }> = [
  { stage: "one_week", hoursBeforeDeadline: 168 },
  { stage: "final_48h", hoursBeforeDeadline: 48 },
  { stage: "last_call", hoursBeforeDeadline: 12 },
];

/**
 * Which stages is this audience eligible for?
 *
 * `last_call` is deliberately narrow. A twelve-hour warning to someone who has
 * shown no interest is a nuisance; to someone with an unfinished cart it is a
 * favour. The difference is whether they have already told you they want
 * something.
 */
function stagesFor(audience: Audience): ReminderStage[] {
  switch (audience) {
    case "never_claimed":
      return ["gallery_open", "one_week", "final_48h"];
    case "claimed_no_order":
      return ["one_week", "final_48h"];
    case "cart_abandoned":
      return ["final_48h", "last_call"];
  }
}

/**
 * Nudge a timestamp into the next acceptable sending window.
 *
 * Scheduled sends drift into the small hours — a deadline at 09:00 minus 48
 * hours is 09:00, but a deadline at midnight minus 12 hours is noon, and one at
 * 06:00 minus 48 hours lands at 06:00. A push notification about your child's
 * school photographs at 03:00 is the kind of thing people screenshot.
 */
export function respectQuietHours(when: Date): Date {
  const out = new Date(when);
  const h = out.getUTCHours();
  if (h < QUIET_HOURS.startHour) {
    out.setUTCHours(QUIET_HOURS.startHour, 0, 0, 0);
  } else if (h >= QUIET_HOURS.endHour) {
    out.setUTCDate(out.getUTCDate() + 1);
    out.setUTCHours(QUIET_HOURS.startHour, 0, 0, 0);
  }
  return out;
}

function pickChannel(r: Recipient): Channel | null {
  // Email first: it costs nothing, carries the gallery link cleanly, and is
  // what the account was created with. SMS only where there is no address,
  // because it costs real money per send and cannot carry a proper link.
  if (r.email) return "email";
  if (r.phone) return "sms";
  return null;
}

export interface PlanResult {
  sends: PlannedSend[];
  /** Everyone excluded, with the reason. Never silently dropped. */
  skipped: Array<{ recipient: Recipient; reason: string }>;
}

/**
 * Plan the reminders due for a shoot as at `now`.
 *
 * Idempotent by construction: it takes what has already been sent and never
 * proposes the same stage twice. A scheduler that runs hourly can call this
 * every hour without the risk of a parent getting the same message twelve times
 * because a job retried.
 */
export function planReminders(
  now: Date,
  shoot: ShootWindow,
  recipients: Recipient[],
  alreadySent: SentRecord[],
): PlanResult {
  const sends: PlannedSend[] = [];
  const skipped: PlanResult["skipped"] = [];

  const closesAt = new Date(
    shoot.orderDeadlineAt.getTime() + shoot.graceHours * 3_600_000,
  );

  // Past the grace period there is nothing to remind anyone about, and a
  // reminder for a closed gallery is worse than none: it invites a request the
  // studio then has to refuse.
  if (now >= closesAt) {
    return {
      sends: [],
      skipped: recipients.map((r) => ({ recipient: r, reason: "ordering has closed" })),
    };
  }

  const sentKey = (guardianId: string | null, childId: string, stage: string) =>
    `${guardianId ?? "-"}\u0000${childId}\u0000${stage}`;
  const sentSet = new Set(
    alreadySent.map((s) => sentKey(s.guardianId, s.childId, s.stage)),
  );

  const countPerGuardian = new Map<string, number>();
  for (const s of alreadySent) {
    const k = `${s.guardianId ?? "-"}\u0000${s.childId}`;
    countPerGuardian.set(k, (countPerGuardian.get(k) ?? 0) + 1);
  }

  for (const r of recipients) {
    if (r.childSuppressed) {
      // The register is absolute. Not "send a neutral version" — nothing.
      skipped.push({ recipient: r, reason: "child is on the suppression register" });
      continue;
    }
    if (r.unsubscribedAt) {
      skipped.push({ recipient: r, reason: "guardian has opted out" });
      continue;
    }

    const channel = pickChannel(r);
    if (!channel) {
      skipped.push({ recipient: r, reason: "no email address or phone number" });
      continue;
    }

    const guardKey = `${r.guardianId ?? "-"}\u0000${r.childId}`;
    let alreadyCount = countPerGuardian.get(guardKey) ?? 0;
    const eligible = stagesFor(r.audience);

    if (alreadyCount >= MAX_PER_SHOOT) {
      skipped.push({ recipient: r, reason: `frequency cap of ${MAX_PER_SHOOT} reached` });
      continue;
    }

    // Every stage that is eligible, due, and not yet sent.
    const outstanding = eligible
      .filter((stage) => !sentSet.has(sentKey(r.guardianId, r.childId, stage)))
      .map((stage) => ({ stage, due: dueAt(stage, shoot) }))
      .filter(
        (x): x is { stage: ReminderStage; due: Date } =>
          x.due !== null && x.due <= now && x.due >= shoot.galleryOpensAt,
      )
      .sort((a, b) => b.due.getTime() - a.due.getTime());

    if (outstanding.length === 0) continue;

    // Send ONLY the most recent one. If the scheduler was down for a day, or a
    // shoot was set up late, several stages come due at once — and firing them
    // all means a parent gets "one week left" and "48 hours left" in the same
    // minute, which reads as a malfunction and is one step from a complaint.
    // The stale stages are consumed, not queued.
    const [current, ...superseded] = outstanding;

    sends.push({
      recipient: r,
      stage: current!.stage,
      channel,
      sendAt: respectQuietHours(now),
      template: `${current!.stage}.${r.audience}.${channel}`,
      supersedes: superseded.map((s) => s.stage),
    });
    alreadyCount++;

    for (const s of superseded) {
      skipped.push({
        recipient: r,
        reason: `stage "${s.stage}" superseded by "${current!.stage}"`,
      });
    }
  }

  return { sends, skipped };
}

function dueAt(stage: ReminderStage, shoot: ShootWindow): Date | null {
  if (stage === "gallery_open") {
    return new Date(shoot.galleryOpensAt.getTime() + 48 * 3_600_000);
  }
  const offset = STAGE_OFFSETS.find((s) => s.stage === stage);
  if (!offset) return null;
  return new Date(shoot.orderDeadlineAt.getTime() - offset.hoursBeforeDeadline * 3_600_000);
}

/**
 * Is this message a service message or direct marketing?
 *
 * POPIA s69 restricts unsolicited electronic direct marketing. A reminder that
 * a gallery a parent was given a code for is closing is a service message about
 * a thing they already have. "Book your family portrait session" to the same
 * list is marketing and needs its own opt-in.
 *
 * The distinction is not decorative: getting it wrong is what turns a school
 * photography contract into a complaint to the Information Regulator. It lives
 * here, in code, so a future template cannot quietly cross the line.
 */
export function classifyMessage(template: string): "service" | "marketing" {
  const serviceStages = ["gallery_open", "one_week", "final_48h", "last_call"];
  return serviceStages.some((s) => template.startsWith(s)) ? "service" : "marketing";
}

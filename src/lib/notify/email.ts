/**
 * Address validation, typo correction, and deciding what mail an order sends.
 *
 * The studio's requirement was "the system needs to check if the emails are
 * correct". Two different problems hide in that sentence:
 *
 *   SYNTACTICALLY INVALID  — "noah@gmail" or "noah gmail.com". Catchable with
 *                            certainty, and should be blocked at the field.
 *   PLAUSIBLE BUT WRONG    — "noah@gmial.com". Perfectly valid, will deliver
 *                            nowhere, and is the one that actually happens.
 *
 * The second is where the value is. A parent who mistypes their address pays
 * for photographs and never receives them, then telephones the school, who
 * telephone the studio. Catching it costs one confirmation tap.
 */

export interface EmailCheck {
  valid: boolean;
  normalised: string;
  /** A domain we think they meant. Never applied automatically. */
  suggestion: string | null;
  /** Shown to the parent, in plain words. */
  message: string | null;
  /** Shared inbox rather than a person: info@, admin@, accounts@. */
  isRoleAddress: boolean;
}

/**
 * Deliberately not the RFC 5322 grammar.
 *
 * The full grammar admits addresses no mail provider will accept and no parent
 * will ever type, and implementing it correctly is a well-known way to ship a
 * catastrophically slow regex. This is the pragmatic subset: something, an @,
 * a domain with at least one dot, and a TLD of two or more letters.
 */
const SHAPE = /^[^\s@,;:<>()[\]\\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Domains a South African parent actually uses.
 *
 * The local ones matter as much as the global ones. A generic typo checker
 * built for a US audience knows gmail and hotmail and has never heard of
 * telkomsa.net or webmail.co.za, which is most of the point.
 */
const KNOWN_DOMAINS = [
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "protonmail.com",
  "webmail.co.za", "telkomsa.net", "mweb.co.za", "vodamail.co.za",
  "absamail.co.za", "iafrica.com", "polka.co.za", "lantic.net",
  "gmail.co.za", "yahoo.co.za", "hotmail.co.za", "outlook.co.za",
];

/** Shared inboxes. Usually the school office, not the parent. */
const ROLE_LOCALPARTS = new Set([
  "info", "admin", "office", "accounts", "sales", "support",
  "enquiries", "reception", "secretary", "principal", "school",
]);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function checkEmail(input: string): EmailCheck {
  const normalised = input.trim().toLowerCase().replace(/\s+/g, "");

  const base: EmailCheck = {
    valid: false, normalised, suggestion: null, message: null, isRoleAddress: false,
  };

  if (!normalised) {
    return { ...base, message: "Enter an email address so we can send your photographs." };
  }
  if (!normalised.includes("@")) {
    return { ...base, message: "That address is missing an @ sign." };
  }
  if (!SHAPE.test(normalised)) {
    return { ...base, message: "That does not look like a complete email address." };
  }

  const at = normalised.lastIndexOf("@");
  const local = normalised.slice(0, at);
  const domain = normalised.slice(at + 1);

  const isRoleAddress = ROLE_LOCALPARTS.has(local);

  // Exact match on a known domain: nothing to suggest.
  if (KNOWN_DOMAINS.includes(domain)) {
    return {
      valid: true, normalised, suggestion: null, isRoleAddress,
      message: isRoleAddress
        ? "That looks like a shared office address. Photographs sent there may not reach you."
        : null,
    };
  }

  // One or two characters away from a domain we know is almost always a slip.
  // Three or more is somebody's genuinely unusual company domain, and
  // "correcting" it would be worse than saying nothing.
  let best: { domain: string; distance: number } | null = null;
  for (const known of KNOWN_DOMAINS) {
    const d = levenshtein(domain, known);
    if (d > 0 && d <= 2 && (!best || d < best.distance)) best = { domain: known, distance: d };
  }

  if (best) {
    const suggestion = `${local}@${best.domain}`;
    return {
      valid: true, normalised, suggestion, isRoleAddress,
      message: `Did you mean ${suggestion}?`,
    };
  }

  return { valid: true, normalised, suggestion: null, isRoleAddress, message: null };
}

// ── What an order sends, and when ───────────────────────────────────────────

export interface OrderMailContext {
  orderId: string;
  orderNumber: string;
  guardianId: string;
  toEmail: string;
  hasDigitalLines: boolean;
  hasPhysicalLines: boolean;
  paymentSettled: boolean;
  /** Studio-chosen release rule for this shoot. */
  digitalRelease: "on_payment" | "on_deadline" | "manual";
  orderDeadlineAt: Date;
  /** Null until the studio picks a date. */
  physicalDispatchAt: Date | null;
}

export interface QueuedEmail {
  templateKey: string;
  scheduledFor: Date;
  /** Unique per order per purpose. The outbox unique index does the rest. */
  idempotencyKey: string;
  /** True when download links must be attached at send time. */
  includesDownloads: boolean;
}

/**
 * Decide the mail an order generates.
 *
 * Deliberately a plan rather than a send. Everything lands in the outbox with a
 * schedule and an idempotency key, so a duplicated payment webhook, a retried
 * job or a double-clicked button cannot produce two thank-you emails — which is
 * the failure mode parents notice and mention.
 */
export function planOrderEmails(now: Date, ctx: OrderMailContext): QueuedEmail[] {
  if (!ctx.paymentSettled) return [];

  const out: QueuedEmail[] = [];

  // Always: the receipt, immediately. It is the thing a parent looks for when
  // they wonder whether the payment worked.
  out.push({
    templateKey: "order.paid",
    scheduledFor: now,
    idempotencyKey: `order.paid:${ctx.orderNumber}`,
    includesDownloads: false,
  });

  if (ctx.hasDigitalLines) {
    // "As soon as the person has paid" — so the download email is separate from
    // the receipt and goes out on its own clock. Bundling them would mean a
    // studio that releases digitals on the deadline could not send a receipt
    // until then.
    const when =
      ctx.digitalRelease === "on_payment" ? now
      : ctx.digitalRelease === "on_deadline" ? ctx.orderDeadlineAt
      : null;

    if (when) {
      out.push({
        templateKey: "digital.ready",
        scheduledFor: when,
        idempotencyKey: `digital.ready:${ctx.orderNumber}`,
        includesDownloads: true,
      });
    }
  }

  if (ctx.hasPhysicalLines) {
    // Sets the expectation the same day, so nobody wonders on day three where
    // their prints are. If no dispatch date is set yet, the mail still goes —
    // with "we will confirm the date" copy — because silence reads worse than
    // an approximate answer.
    out.push({
      templateKey: ctx.physicalDispatchAt ? "physical.scheduled" : "physical.pending",
      scheduledFor: now,
      idempotencyKey: `physical.notice:${ctx.orderNumber}`,
      includesDownloads: false,
    });
  }

  return out;
}

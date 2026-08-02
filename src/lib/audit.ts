import type { PoolClient } from "pg";

/**
 * Audit log writer.
 *
 * The hash chain is computed in the database (migration 0007), not here, so
 * that an event written by any client — the app, a migration, a psql session —
 * links into the same chain. Application code only supplies the facts.
 *
 * Architecture §15.3.
 */

/**
 * The action vocabulary, as a closed union.
 *
 * Free-text action names rot: six months in you have 'gallery.view',
 * 'gallery.viewed' and 'viewGallery' in the same table and no reliable way to
 * answer "who viewed this child's gallery". Adding an action should be a
 * deliberate edit to this list.
 */
export type AuditAction =
  // Access
  | "claim.issued"
  | "claim.redeemed"
  | "claim.revoked"
  | "claim.regenerated"
  | "gallery.viewed"
  | "asset.downloaded"
  | "binding.created"
  | "binding.revoked"
  | "consent.granted"
  | "consent.withdrawn"
  // Staff
  | "staff.signed_in"
  | "staff.signed_out"
  | "staff.role_changed"
  | "staff.viewed_child"
  | "staff.viewed_guardian"
  | "staff.impersonated_guardian"
  // Catalogue and money
  | "price.changed"
  | "package.changed"
  | "order.placed"
  | "order.paid"
  | "order.refunded"
  | "order.cancelled"
  | "order.fulfilment_changed"
  // Data lifecycle
  | "child.suppressed"
  | "child.unsuppressed"
  | "shoot.opened"
  | "shoot.closed"
  | "export.generated"
  | "retention.deleted";

export interface AuditEntry {
  studioId: string;
  actorKind: "staff" | "guardian" | "anonymous" | "system";
  actorId?: string | null;
  /** Denormalised so the log stays readable after the actor row is deleted. */
  actorLabel?: string | null;
  action: AuditAction;
  subjectType: string;
  subjectId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append one event.
 *
 * Takes the caller's client rather than opening its own, so the audit write
 * lands in the same transaction as the thing it describes. If the operation
 * rolls back, so does its audit entry — a log full of events that never
 * happened is worse than no log.
 */
export async function audit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `insert into audit_event
       (studio_id, actor_kind, actor_id, actor_label, action,
        subject_type, subject_id, ip, user_agent, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.studioId,
      entry.actorKind,
      entry.actorId ?? null,
      entry.actorLabel ?? null,
      entry.action,
      entry.subjectType,
      entry.subjectId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(scrub(entry.meta ?? {})),
    ],
  );
}

/**
 * Keys that must never reach the audit log.
 *
 * The log is retained three years and read during incidents, often by more
 * people than usual. A credential that leaks into it is a credential with a
 * three-year exposure window and a wide audience.
 */
const FORBIDDEN_META_KEYS = new Set([
  "code",
  "claim_code",
  "claimCode",
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "card",
  "cardNumber",
  "cvv",
  "id_number",
  "idNumber",
]);

function scrub(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_META_KEYS.has(k)) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrub(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  reason: string | null;
}

/** Walk the chain for a studio. Run on a schedule and after any incident. */
export async function verifyAuditChain(
  client: PoolClient,
  studioId: string,
): Promise<ChainVerification> {
  const { rows } = await client.query(
    "select ok, checked, first_bad_seq, reason from app.audit_verify($1)",
    [studioId],
  );
  const r = rows[0];
  return {
    ok: r.ok,
    checked: Number(r.checked),
    firstBadSeq: r.first_bad_seq === null ? null : Number(r.first_bad_seq),
    reason: r.reason,
  };
}

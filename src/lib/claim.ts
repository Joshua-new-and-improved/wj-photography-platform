import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";
import type { PoolClient } from "pg";
import { generateClaimCode, normaliseCode, isWellFormedClaimCode } from "./ids.js";

/**
 * The claim model (architecture §6.2).
 *
 * Possession of the printed slip lets you claim **once**. Access after that is
 * an authenticated relationship, not a bearer token.
 *
 * This replaces the reference workflow's "enter your Unique ID to see your
 * photo" box, whose identifier was short, structured, permanently valid, and
 * printed — a credential that is enumerable by counting, shareable without
 * trace, and impossible to revoke (§3.7).
 */

/**
 * Argon2id parameters.
 *
 * A claim code has ~50 bits of entropy from a 32-symbol alphabet. That is
 * ample against a rate limiter and *not* ample against an offline attack on a
 * leaked database, which is exactly the case a slow hash exists for. These
 * settings target roughly 50 ms per verification on modest hardware: slow
 * enough to make bulk cracking expensive, fast enough that a parent at 21:00
 * does not notice.
 *
 * Session tokens deliberately use SHA-256 instead (see ids.ts). They are 256
 * random bits, so there is nothing to brute-force and a slow hash would buy
 * latency and nothing else.
 */
const ARGON = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP's floor for Argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

/** Attempts per IP per window before the door closes. */
export const RATE_LIMIT = { attempts: 5, windowSeconds: 60, lockoutSeconds: 900 };

export type RedeemOutcome =
  | "success"
  | "not_found"
  | "expired"
  | "revoked"
  | "already_redeemed"
  | "rate_limited"
  | "malformed";

export interface RedeemResult {
  outcome: RedeemOutcome;
  childId?: string;
  shootId?: string;
  claimCodeId?: string;
  /** What the parent sees. Deliberately identical for several outcomes. */
  message: string;
}

/**
 * Issue a code for a child on a shoot.
 *
 * Returns the plaintext exactly once — it is never stored and cannot be
 * recovered. If the studio loses the printout, the answer is to regenerate,
 * which is a feature rather than a limitation: it means a leaked database
 * does not compromise a single slip.
 */
export async function issueClaimCode(
  client: PoolClient,
  opts: { studioId: string; childId: string; shootId: string; expiresAt: Date },
): Promise<{ id: string; plain: string; grouped: string; generation: number }> {
  const { plain, grouped, hint } = generateClaimCode();
  const codeHash = await argonHash(plain, ARGON);

  // Regenerating supersedes the previous generation. The old code stops
  // working the moment this row lands — which is what the brief's
  // "regenerate QR codes" has to mean to be worth anything (§6.2).
  const { rows } = await client.query(
    `insert into claim_code
       (studio_id, child_id, shoot_id, code_hash, code_hint, generation, expires_at)
     select $1, $2, $3, $4, $5,
            coalesce((select max(generation) from claim_code
                       where child_id = $2 and shoot_id = $3), 0) + 1,
            $6
     returning id, generation`,
    [opts.studioId, opts.childId, opts.shootId, Buffer.from(codeHash), hint, opts.expiresAt],
  );

  // Supersede every earlier generation in the same statement scope, so there
  // is never a window in which two codes are live for one child.
  await client.query(
    `update claim_code set revoked_at = now()
      where child_id = $1 and shoot_id = $2 and id <> $3
        and revoked_at is null and redeemed_at is null`,
    [opts.childId, opts.shootId, rows[0].id],
  );

  return { id: rows[0].id, plain, grouped, generation: rows[0].generation };
}

/**
 * Has this IP earned a pause?
 *
 * At ~50 bits of entropy and five attempts a minute, brute force is not a
 * threat model, it is a rounding error. The limiter exists less to stop
 * guessing than to make an enumeration attempt *visible* — a burst of
 * not_found outcomes from one address is a signal worth alerting on.
 */
export async function isRateLimited(client: PoolClient, ip: string): Promise<boolean> {
  const { rows } = await client.query(
    `select count(*)::int as n
       from claim_attempt
      where ip = $1
        and attempted_at > now() - make_interval(secs => $2)
        and outcome <> 'success'`,
    [ip, RATE_LIMIT.windowSeconds],
  );
  return rows[0].n >= RATE_LIMIT.attempts;
}

/**
 * Redeem a code.
 *
 * Argon2 hashes are salted per row, so there is no way to look a code up by
 * hash — every live candidate for the shoot has to be verified in turn. At a
 * few hundred codes per shoot that is acceptable, and the shoot is identified
 * from the QR URL rather than being guessed at.
 *
 * If a shoot ever grows past a few thousand live codes, the fix is a fast
 * keyed lookup index (HMAC of the code under a server-side pepper) alongside
 * the Argon2 hash — not weakening the hash.
 */
export async function redeemClaimCode(
  client: PoolClient,
  opts: { submitted: string; shootId: string; ip: string },
): Promise<RedeemResult> {
  const code = normaliseCode(opts.submitted);

  const record = async (outcome: RedeemOutcome, claimCodeId?: string) => {
    if (outcome === "malformed") return; // nothing to log but noise
    await client.query(
      `insert into claim_attempt (ip, code_hint, outcome, claim_code_id)
       values ($1, $2, $3, $4)`,
      [opts.ip, code.slice(-3) || null, outcome, claimCodeId ?? null],
    );
  };

  if (!isWellFormedClaimCode(code)) {
    return { outcome: "malformed", message: GENERIC_FAILURE };
  }

  if (await isRateLimited(client, opts.ip)) {
    await record("rate_limited");
    return {
      outcome: "rate_limited",
      message: "Too many attempts. Please wait a few minutes and try again.",
    };
  }

  const { rows } = await client.query(
    `select id, child_id, shoot_id, code_hash, expires_at, redeemed_at, revoked_at
       from claim_code
      where shoot_id = $1 and code_hint = $2`,
    [opts.shootId, code.slice(-3)],
  );

  for (const r of rows) {
    let matches = false;
    try {
      matches = await argonVerify(r.code_hash.toString(), code, ARGON);
    } catch {
      matches = false; // corrupt hash: treat as no match, never as a match
    }
    if (!matches) continue;

    if (r.revoked_at) {
      await record("revoked", r.id);
      return {
        outcome: "revoked",
        message:
          "This code has been replaced. Check for a newer letter, or contact the studio.",
      };
    }
    if (r.expires_at <= new Date()) {
      await record("expired", r.id);
      return {
        outcome: "expired",
        message: "This gallery has closed. Contact the studio if you still need access.",
      };
    }
    if (r.redeemed_at) {
      // Deliberately distinguishable from not_found. If a slip was
      // intercepted, this is the message that tells the real parent something
      // is wrong — and it is the signal that brings them to the studio.
      await record("already_redeemed", r.id);
      return {
        outcome: "already_redeemed",
        message:
          "This code has already been used. Sign in with the account it was linked to, " +
          "or contact the studio if that was not you.",
      };
    }

    await record("success", r.id);
    return {
      outcome: "success",
      childId: r.child_id,
      shootId: r.shoot_id,
      claimCodeId: r.id,
      message: "",
    };
  }

  await record("not_found");
  return { outcome: "not_found", message: GENERIC_FAILURE };
}

/**
 * One message for both "no such code" and "malformed code".
 *
 * Distinguishing them would let an attacker confirm which prefixes exist,
 * turning a 50-bit search into a much smaller one.
 */
const GENERIC_FAILURE =
  "That code was not recognised. Check the letter and try again — the letters " +
  "I, L, O and U are never used, so those are probably 1, 1, 0 and V.";

/**
 * Bind the guardian, burn the code, record consent.
 *
 * Everything in one transaction. A binding without a burned code would let the
 * slip be reused; a burned code without a binding would lock the parent out
 * with no way back except a support call.
 */
export async function completeClaim(
  client: PoolClient,
  opts: {
    studioId: string;
    claimCodeId: string;
    childId: string;
    shootId: string;
    guardianId: string;
    ip: string;
    relationship?: string;
    consentWordingVersion: string;
    locale: "en";
  },
): Promise<void> {
  const burned = await client.query(
    `update claim_code
        set redeemed_at = now(), redeemed_by = $2, redeemed_ip = $3
      where id = $1 and redeemed_at is null and revoked_at is null
        and expires_at > now()
      returning id`,
    [opts.claimCodeId, opts.guardianId, opts.ip],
  );

  // Two parents scanning the same QR at the same moment: exactly one wins.
  if (burned.rowCount === 0) {
    throw new Error("Claim code was consumed or invalidated before completion.");
  }

  await client.query(
    `insert into guardian_child
       (studio_id, guardian_id, child_id, relationship, bound_via, bound_ip)
     values ($1, $2, $3, $4, 'claim_code', $5)
     on conflict (guardian_id, child_id) do update
        set revoked_at = null, bound_at = now()`,
    [opts.studioId, opts.guardianId, opts.childId, opts.relationship ?? "parent", opts.ip],
  );

  // POPIA s35 lawful basis, evidenced per child per shoot. A consent whose
  // exact wording you cannot reproduce is a consent you cannot prove (§3.3).
  await client.query(
    `insert into consent_record
       (studio_id, child_id, guardian_id, shoot_id, scope,
        wording_version, locale, evidence)
     values ($1, $2, $3, $4, 'service', $5, $6, $7)
     on conflict do nothing`,
    [
      opts.studioId,
      opts.childId,
      opts.guardianId,
      opts.shootId,
      opts.consentWordingVersion,
      opts.locale,
      JSON.stringify({ ip: opts.ip, at: new Date().toISOString() }),
    ],
  );
}

/** Revoke without reissuing — for a slip known to be compromised. */
export async function revokeClaimCode(
  client: PoolClient,
  claimCodeId: string,
  staffId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update claim_code set revoked_at = now(), revoked_by = $2
      where id = $1 and revoked_at is null`,
    [claimCodeId, staffId],
  );
  return (rowCount ?? 0) > 0;
}

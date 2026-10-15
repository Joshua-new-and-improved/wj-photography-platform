import type { Pool, PoolClient } from "pg";
import type { Request, Response } from "express";
import { generateSessionToken, hashToken } from "../lib/ids.js";

/**
 * Parent access: who is this browser, and which children may it see?
 *
 * The rule, enforced here AND again by the database when it can be (below):
 * a browser may see a child only if
 *   1. it carries a live guardian_session cookie,
 *   2. that session's child_scope contains the child — i.e. the child's card
 *      was entered in THIS browser, and
 *   3. the session's guardian has a live guardian_child binding to the child.
 *
 * The card is the credential. Entering it again on another phone (the other
 * parent, a new device) works and binds that browser's own guardian; it never
 * hands over someone else's session. Wiaan revoking a code stops new entries.
 */

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;

export interface ParentSession {
  id: string;
  guardianId: string;
  childScope: string[];
}

export async function readParentSession(db: Pool | PoolClient, req: Request): Promise<ParentSession | null> {
  const token = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token || token.length < 32 || token.length > 128) return null;
  const r = await db.query(
    `update guardian_session set last_used_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      returning id, guardian_id, child_scope`,
    [hashToken(token)],
  );
  if (r.rowCount === 0) return null;
  return { id: r.rows[0].id, guardianId: r.rows[0].guardian_id, childScope: r.rows[0].child_scope ?? [] };
}

export async function sessionCanViewChild(db: Pool | PoolClient, s: ParentSession | null, childId: string): Promise<boolean> {
  if (!s || !s.childScope.includes(childId)) return false;
  const r = await db.query(
    `select 1 from guardian_child gc join child c on c.id = gc.child_id
      where gc.guardian_id = $1 and gc.child_id = $2 and gc.revoked_at is null
        and c.suppression_status = 'none'`,
    [s.guardianId, childId],
  );
  return r.rowCount! > 0;
}

/** Create a guardian for a browser that has none yet. Email is filled in at checkout. */
export async function createAnonymousGuardian(client: PoolClient): Promise<string> {
  const r = await client.query(
    `insert into guardian (email, full_name, verified_at)
     values ('parent-' || app.uuidv7() || '@claim.invalid', 'Parent', null) returning id`,
  );
  return r.rows[0].id;
}

/** Add a child to the browser's existing session, or start one. */
export async function grantChildToBrowser(
  client: PoolClient, req: Request, res: Response, existing: ParentSession | null, guardianId: string, childId: string,
): Promise<void> {
  if (existing && existing.guardianId === guardianId) {
    await client.query(
      `update guardian_session
          set child_scope = (select array_agg(distinct x) from unnest(array_append(child_scope, $2::uuid)) x)
        where id = $1`,
      [existing.id, childId],
    );
    return;
  }
  const token = generateSessionToken();
  await client.query(
    `insert into guardian_session (guardian_id, token_hash, ip, user_agent, expires_at, child_scope)
     values ($1, $2, $3, $4, now() + make_interval(days => $5), array[$6::uuid])`,
    [guardianId, hashToken(token), req.ip ?? null, (req.get("user-agent") ?? "").slice(0, 300), SESSION_DAYS, childId],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_DAYS * 86_400_000,
    path: "/",
  });
}

/**
 * Run parent-facing reads as the guardian, under the database's own row-level
 * policies — a second, independent lock behind sessionCanViewChild.
 *
 * The server's pool connects as a superuser (it has to: it bootstraps the
 * studio), and superusers bypass RLS entirely, FORCE or not. `SET LOCAL ROLE
 * app_rw` drops to the unprivileged role for this one transaction, so the
 * guardian policies in 0008 actually apply. If the role switch is unavailable
 * the app-level check above still stands alone, and /api/health says so.
 */
let rlsRoleAvailable: boolean | null = null;

export async function probeRlsRole(pool: Pool): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role app_rw");
    await c.query("rollback");
    rlsRoleAvailable = true;
  } catch {
    await c.query("rollback").catch(() => {});
    rlsRoleAvailable = false;
  } finally {
    c.release();
  }
  return rlsRoleAvailable;
}

export const rlsEnforcedForParents = () => rlsRoleAvailable === true;

export async function asGuardianRls<T>(pool: Pool, guardianId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (rlsRoleAvailable) await c.query("set local role app_rw");
    await c.query("select set_config('app.actor_kind', 'guardian', true)");
    await c.query("select set_config('app.guardian_id', $1, true)", [guardianId]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

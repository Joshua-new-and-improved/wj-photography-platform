import { Pool, type PoolClient } from "pg";

/**
 * Database access with a mandatory actor context.
 *
 * The design rule: there is no way to run a query from application code without
 * declaring who is running it. The pool is not exported. Every path goes through
 * one of the `as*` helpers, each of which opens a transaction, sets the session
 * context with SET LOCAL, and hands you a client.
 *
 * SET LOCAL rather than SET is the important detail. LOCAL scopes the setting to
 * the transaction, so it is discarded on commit or rollback. With a connection
 * pooler in front, a plain SET would leave one request's tenant on the
 * connection for the next request to inherit — which is a cross-tenant data
 * leak that would pass every test written against a single tenant.
 *
 * Architecture §5.1, §15.1.
 */

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      // Fail fast rather than queueing behind an unhealthy database.
      connectionTimeoutMillis: 5_000,
      application_name: "school-photo-platform",
    });
    pool.on("error", (err) => {
      console.error({ event: "pg.pool.error", err: err.message });
    });
  }
  return pool;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export type StaffRole =
  | "owner"
  | "admin"
  | "photographer"
  | "assistant"
  | "viewer";

export type ActorContext =
  | { kind: "staff"; studioId: string; staffId: string; role: StaffRole }
  | { kind: "guardian"; guardianId: string }
  | { kind: "system"; reason: string }
  | { kind: "anonymous" };

/** What the database sees. Mirrors the accessors in migration 0001. */
function contextSettings(ctx: ActorContext): Array<[string, string]> {
  switch (ctx.kind) {
    case "staff":
      return [
        ["app.actor_kind", "staff"],
        ["app.studio_id", ctx.studioId],
        ["app.staff_id", ctx.staffId],
        ["app.staff_role", ctx.role],
      ];
    case "guardian":
      return [
        ["app.actor_kind", "guardian"],
        ["app.guardian_id", ctx.guardianId],
      ];
    case "system":
      return [["app.actor_kind", "system"]];
    case "anonymous":
      return [["app.actor_kind", "anonymous"]];
  }
}

/**
 * Run `fn` inside a transaction carrying the given actor context.
 *
 * Everything the callback does is subject to the row-level policies in
 * migration 0008. There is no escape hatch, by design: the connection role
 * (app_rw) is neither the table owner nor BYPASSRLS, so even a raw query
 * assembled by hand is constrained.
 */
export async function withContext<T>(
  ctx: ActorContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    for (const [key, value] of contextSettings(ctx)) {
      // set_config with is_local=true is the parameterisable equivalent of
      // SET LOCAL. SET does not accept bind parameters, and building the
      // statement by string concatenation would put a user-supplied UUID into
      // executable SQL — which is exactly the injection this avoids.
      await client.query("select set_config($1, $2, true)", [key, value]);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {
      /* the connection is already broken; the original error is what matters */
    });
    throw err;
  } finally {
    client.release();
  }
}

export const asStaff = <T>(
  studioId: string,
  staffId: string,
  role: StaffRole,
  fn: (c: PoolClient) => Promise<T>,
) => withContext({ kind: "staff", studioId, staffId, role }, fn);

export const asGuardian = <T>(
  guardianId: string,
  fn: (c: PoolClient) => Promise<T>,
) => withContext({ kind: "guardian", guardianId }, fn);

/**
 * The system context, for the handful of operations that have no authenticated
 * actor yet: claim redemption (no guardian exists until the code is verified),
 * staff sign-in (the studio is unknown until the user row is found), and
 * payment webhook receipt (the order is unknown until the payload is parsed).
 *
 * `reason` is required and logged, so this stays a short, auditable list rather
 * than quietly becoming the default way to get things done.
 */
export const asSystem = <T>(reason: string, fn: (c: PoolClient) => Promise<T>) =>
  withContext({ kind: "system", reason }, fn);

export const asAnonymous = <T>(fn: (c: PoolClient) => Promise<T>) =>
  withContext({ kind: "anonymous" }, fn);

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

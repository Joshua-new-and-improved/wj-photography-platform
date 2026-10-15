import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

/**
 * Apply pending migrations on boot, so a push that adds one needs nobody to
 * open a database console. Same bookkeeping table as scripts/db-migrate.sh.
 *
 * The one dangerous case is a database migrated by hand before this existed:
 * it has the whole schema but no schema_migration table, and naively
 * "applying everything" would re-run 0001 over live data. So when the schema
 * is present but the table is not, we baseline — record every migration up to
 * the newest one whose signature object we can SEE as applied — and refuse to
 * guess if the signature is missing. A refusal is logged loudly and the server
 * keeps running on the schema it has.
 *
 * An advisory lock keeps two booting instances from racing each other.
 */

const MIGRATIONS_DIR = new URL("../../db/migrations", import.meta.url).pathname;

/** Migration known to be the last one applied by hand, and proof that it was. */
const BASELINE = {
  upTo: "0014_claim_flow_gap.sql",
  proof: `select 1 from pg_policies where tablename = 'consent_record' and policyname = 'system_create_consent'`,
};

const LOCK_KEY = 815_001;

export async function migrateOnBoot(pool: Pool): Promise<{ applied: string[]; status: string }> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

    const hasTable = (await client.query(`select to_regclass('public.schema_migration') as t`)).rows[0].t;
    if (!hasTable) {
      const hasSchema = (await client.query(`select to_regclass('public.studio') as t`)).rows[0].t;
      await client.query(`create table schema_migration (
        filename text primary key, applied_at timestamptz not null default now())`);
      if (hasSchema) {
        const proven = (await client.query(BASELINE.proof)).rowCount! > 0;
        if (!proven) {
          await client.query(`drop table schema_migration`);
          console.error({
            event: "migrate.refused",
            reason: `schema exists without schema_migration and ${BASELINE.upTo} cannot be proven applied`,
          });
          return { applied, status: "refused" };
        }
        for (const f of files.filter((f) => f <= BASELINE.upTo)) {
          await client.query(`insert into schema_migration (filename) values ($1)`, [f]);
        }
        console.log({ event: "migrate.baselined", upTo: BASELINE.upTo });
      }
    }

    const done = new Set(
      (await client.query(`select filename from schema_migration`)).rows.map((r) => r.filename as string),
    );
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(`${MIGRATIONS_DIR}/${f}`, "utf8");
      // Each migration file carries its own begin/commit.
      await client.query(sql);
      await client.query(`insert into schema_migration (filename) values ($1)`, [f]);
      applied.push(f);
      console.log({ event: "migrate.applied", file: f });
    }
    return { applied, status: "ok" };
  } catch (err) {
    console.error({ event: "migrate.failed", err: (err as Error).message });
    await client.query("rollback").catch(() => {});
    return { applied, status: "failed" };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

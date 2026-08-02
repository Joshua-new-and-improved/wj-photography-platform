import type { Config } from "drizzle-kit";

/**
 * The SQL migrations in db/migrations are the source of truth, and the Drizzle
 * schema is INTROSPECTED from them (`npm run db:introspect`).
 *
 * This is the opposite of the usual Drizzle workflow, and it is deliberate.
 * Row-level security policies, hash-chain triggers, generated tsvector columns
 * and partial indexes have no faithful representation in a TypeScript schema
 * DSL. Making TypeScript the source of truth would mean either losing those or
 * maintaining them in a parallel set of hand-written migrations that can drift
 * from the ORM's view — and drift in an RLS policy is a security bug that
 * typechecks cleanly.
 *
 * So: write SQL, introspect for types. CI fails if the checked-in introspected
 * schema differs from what a fresh introspection produces.
 */
export default {
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/schema",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL! },
  introspect: { casing: "camel" },
} satisfies Config;

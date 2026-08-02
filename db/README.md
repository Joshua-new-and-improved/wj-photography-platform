# Database

The SQL in `db/migrations` is the source of truth for the schema. Everything
else — the Drizzle types, the application's repository layer — is derived from
it. Read `drizzle.config.ts` for why the dependency runs in that direction.

## Running things

```bash
npm run db:migrate    # apply pending migrations (as app_owner)
npm run db:test       # clean database, all migrations, full assertion suite
npm run db:introspect # regenerate the Drizzle types from the live schema
```

`db:test` builds a throwaway database from scratch every run. It is fast enough
to run on every save and is the gate in CI.

## The two roles, and why it matters

| Role | Used by | Owns tables | Subject to RLS |
|---|---|---|---|
| `app_owner` | migrations only | yes | yes (FORCE is set) |
| `app_rw` | the running application | no | **yes** |

The application connects as `app_rw`. This is not a detail — it is the entire
security model. A table owner bypasses row-level security by default, so
connecting the application as the owner would silently disable all 79 policies
and **nothing would fail visibly**. Every query would just start returning more
rows than it should.

`FORCE ROW LEVEL SECURITY` is set on every table anyway, so even a connection
that arrives as the owner is constrained. Two layers, because the failure mode
of the first is invisible.

## Session context

Nothing runs without an actor. The application sets four settings per
transaction and the policies read them back:

```
app.actor_kind   staff | guardian | system | anonymous
app.studio_id    the tenant, for staff contexts
app.staff_id     who, for auditing
app.staff_role   owner | admin | photographer | assistant | viewer
app.guardian_id  for guardian contexts
```

These are set with `set_config(..., is_local => true)`, the parameterisable form
of `SET LOCAL`. **Never use plain `SET`.** `SET LOCAL` is scoped to the
transaction and discarded at commit; a plain `SET` persists on the pooled
connection and hands one request's tenant to the next request. That is a
cross-tenant leak that passes every test written against a single tenant, which
is most tests.

Use the helpers in `src/lib/db.ts` (`asStaff`, `asGuardian`, `asSystem`) rather
than opening connections directly. The pool is deliberately not exported.

## Writing a migration

1. Number it sequentially. Never edit an applied migration; add a new one.
2. Wrap it in `begin` / `commit`.
3. **A new table needs a policy.** RLS is enabled table-wide by the loop in
   `0008`, so a table with no policy is deny-all, and the application fails at
   runtime with an empty result set rather than an error. CI checks for this —
   it is how the missing `studio` policy was caught.
4. Add assertions to `db/test/` for anything the migration makes true. If a
   rule is worth a constraint, it is worth a test.

## Conventions

- **Money is integer cents** in `bigint`. Never floating point. Every monetary
  row carries a currency even though it is ZAR today.
- **Timestamps are `timestamptz`.** No naked `timestamp`.
- **Identifiers:** `uuid` primary keys via `app.uuidv7()`; a separate
  `public_ref` for anything URL-visible. Never expose a primary key.
- **Soft state, not soft delete:** `status` columns and `revoked_at` timestamps.
  Actual deletion happens through the retention job, deliberately.
- **i18n columns are `jsonb`** keyed by locale, with a check constraint
  requiring both `af` and `en`.
- **Names are normalised** into `*_norm` columns for fuzzy import matching. The
  normaliser lives in the application, because it needs to know that `graad`,
  `gr` and `grade` are the same word.

## Known caveats

**`app.immutable_unaccent`** asserts immutability that `unaccent()` does not
strictly have — a superuser could swap the dictionary. This is the accepted
pattern for using it in a generated column and expression index. If the
dictionary is ever changed, `REINDEX` every index built on it and rebuild
`child.search_vector`.

**`app.uuidv7()`** is a shim for PostgreSQL < 18, which ships a native
`uuidv7()`. On upgrade, the function can be dropped in favour of the built-in
without touching any call site.

**Advisory lock in the audit chain.** `app.audit_chain()` takes a
transaction-scoped advisory lock per studio to serialise appends. At this
system's write volume the contention is negligible. If audit write throughput
ever becomes a bottleneck, the fix is a per-studio partition, not removing the
lock — the lock is what makes the chain a chain.

**Guardian policy recursion.** `app.guardian_bound_to` and
`app.guardian_owns_child` are split for a non-obvious reason: a single
"bound AND not suppressed" function would make the `child` policy call a
function that queries `child`, whose policy calls it again. Infinite recursion,
reported only at query time. The comment above the functions in `0008` explains
which one is safe where. **Do not merge them.**

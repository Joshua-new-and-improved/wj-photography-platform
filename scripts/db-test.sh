#!/usr/bin/env bash
# Rebuild a throwaway database, apply every migration in order, seed the
# fixture, and run the assertion suite. Exits non-zero on the first failure,
# which is what makes it usable as a CI gate.
set -euo pipefail

DB="${TEST_DB:-spp_test}"
PSQL="psql -v ON_ERROR_STOP=1 -q"

cd "$(dirname "$0")/.."

dropdb --if-exists "$DB"
createdb "$DB"

for f in db/migrations/*.sql; do
  echo "migrate: $f"
  $PSQL -d "$DB" -f "$f" > /dev/null
done

$PSQL -d "$DB" -f db/test/00_harness.sql > /dev/null
$PSQL -d "$DB" -f db/test/01_fixture.sql > /dev/null

for f in db/test/0[2-9]_*.sql; do
  echo ""
  echo "test: $f"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done

# Structural guards. These are the checks a human reviewer will not perform
# reliably, and both have caught real omissions: a table with RLS enabled and
# no policy is deny-all, and fails silently at runtime rather than loudly here.
echo ""
echo "structural: RLS enabled and forced on every table"
UNPROTECTED=$(psql -d "$DB" -Atc "
  select coalesce(string_agg(c.relname, ', '), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname not in ('schema_migration')
     and not (c.relrowsecurity and c.relforcerowsecurity)")
if [ -n "$UNPROTECTED" ]; then
  echo "FAILED: tables without forced RLS: $UNPROTECTED"; exit 1
fi

echo "structural: every table has at least one policy"
NOPOLICY=$(psql -d "$DB" -Atc "
  select coalesce(string_agg(c.relname, ', '), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname not in ('schema_migration')
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname)")
if [ -n "$NOPOLICY" ]; then
  echo "FAILED: RLS enabled but no policy (deny-all): $NOPOLICY"; exit 1
fi

echo ""
psql -d "$DB" -c "select * from test.summary();"

FAILED=$(psql -d "$DB" -Atc "select count(*) from test.result where not passed")
if [ "$FAILED" != "0" ]; then
  echo "FAILED: $FAILED assertion(s)"
  psql -d "$DB" -c "select name, detail from test.result where not passed"
  exit 1
fi
echo "All assertions passed."

#!/usr/bin/env bash
# Apply migrations in order against MIGRATION_DATABASE_URL (the owner role).
# Idempotent by convention: every migration is written to be re-runnable, and
# applied migrations are recorded in schema_migration.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL}"

psql "$URL" -v ON_ERROR_STOP=1 -q -c "
  create table if not exists schema_migration (
    filename text primary key,
    applied_at timestamptz not null default now()
  );"

for f in db/migrations/*.sql; do
  name=$(basename "$f")
  applied=$(psql "$URL" -Atc "select 1 from schema_migration where filename = '$name'")
  if [ "$applied" = "1" ]; then
    echo "skip:  $name"
    continue
  fi
  echo "apply: $name"
  psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f"
  psql "$URL" -v ON_ERROR_STOP=1 -q -c \
    "insert into schema_migration (filename) values ('$name')"
done
echo "Migrations up to date."

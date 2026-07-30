#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${root_dir}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${root_dir}/.env"
  set +a
fi

if command -v brew >/dev/null 2>&1; then
  libpq_prefix="$(brew --prefix libpq 2>/dev/null || true)"
  libpq_bin="${libpq_prefix}/bin"
  if [[ -n "${libpq_prefix}" && -d "${libpq_bin}" ]]; then
    export PATH="${libpq_bin}:${PATH}"
  fi
fi

: "${MIGRATION_SOURCE_DATABASE_URL:=${DATABASE_URL:-}}"
: "${MIGRATION_SOURCE_DATABASE_URL:?MIGRATION_SOURCE_DATABASE_URL is required}"
: "${MIGRATION_TARGET_DATABASE_URL:?MIGRATION_TARGET_DATABASE_URL is required}"

if [[ "${MIGRATION_SOURCE_DATABASE_URL}" == "${MIGRATION_TARGET_DATABASE_URL}" ]]; then
  echo "Source and target database URLs must be different." >&2
  exit 1
fi

for command_name in psql pg_dump pg_restore; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing ${command_name}. On macOS run: brew install libpq" >&2
    exit 1
  fi
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/bewin-pg-migration.XXXXXX")"
dump_file="${MIGRATION_DUMP_FILE:-${work_dir}/bewin.dump}"

cleanup() {
  if [[ -z "${MIGRATION_KEEP_DUMP:-}" ]]; then
    rm -rf "${work_dir}"
  else
    echo "Migration dump retained at ${dump_file}"
  fi
}
trap cleanup EXIT

echo "Checking source and target connections..."
source_version="$(psql --dbname="${MIGRATION_SOURCE_DATABASE_URL}" --no-psqlrc --tuples-only --no-align --command="show server_version_num")"
target_version="$(psql --dbname="${MIGRATION_TARGET_DATABASE_URL}" --no-psqlrc --tuples-only --no-align --command="show server_version_num")"

source_major="$((source_version / 10000))"
target_major="$((target_version / 10000))"
if (( target_major < source_major )) && [[ "${MIGRATION_ALLOW_OLDER_TARGET:-}" != "true" ]]; then
  echo "Target PostgreSQL ${target_major} is older than source PostgreSQL ${source_major}." >&2
  echo "Create an Aiven service with the same or newer major version, or explicitly set MIGRATION_ALLOW_OLDER_TARGET=true." >&2
  exit 1
fi

target_tables="$(psql --dbname="${MIGRATION_TARGET_DATABASE_URL}" --no-psqlrc --tuples-only --no-align --command="
  select count(*)::int
  from information_schema.tables
  where table_schema = 'public'
    and table_type = 'BASE TABLE';
")"
if (( target_tables > 0 )) && [[ "${MIGRATION_ALLOW_NONEMPTY_TARGET:-}" != "true" ]]; then
  echo "Target database already contains ${target_tables} public table(s)." >&2
  echo "Use a fresh Aiven database. Set MIGRATION_ALLOW_NONEMPTY_TARGET=true only when replacing a disposable target." >&2
  exit 1
fi

echo "Creating a consistent PostgreSQL dump..."
pg_dump \
  --dbname="${MIGRATION_SOURCE_DATABASE_URL}" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="${dump_file}"

echo "Restoring dump into the target database..."
pg_restore \
  --dbname="${MIGRATION_TARGET_DATABASE_URL}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "${dump_file}"

psql --dbname="${MIGRATION_TARGET_DATABASE_URL}" --no-psqlrc --set=ON_ERROR_STOP=1 --command="analyze"

echo "Verifying table counts and latest data dates..."
node "${root_dir}/scripts/verify-postgres-migration.js"
echo "PostgreSQL migration completed and verified."

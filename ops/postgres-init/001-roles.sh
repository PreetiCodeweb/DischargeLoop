#!/bin/sh
# Runs once, as the Postgres superuser, when the data volume is first initialised.
# Creates least-privilege roles: the migrator owns the schemas; the API role can only read/write rows.
set -eu

echo "Creating DischargeLoop database roles, schemas and extensions..."

# Passwords come from the stack's .env. They may be omitted only for a throwaway trust-auth test container.
if [ -z "${APP_DB_PASSWORD:-}" ] || [ -z "${MIGRATION_DB_PASSWORD:-}" ]; then
  if [ "${POSTGRES_HOST_AUTH_METHOD:-}" != "trust" ]; then
    echo "APP_DB_PASSWORD and MIGRATION_DB_PASSWORD are required" >&2
    exit 1
  fi
fi
app_pw_clause=""; mig_pw_clause=""
[ -n "${APP_DB_PASSWORD:-}" ] && app_pw_clause="PASSWORD '${APP_DB_PASSWORD}'"
[ -n "${MIGRATION_DB_PASSWORD:-}" ] && mig_pw_clause="PASSWORD '${MIGRATION_DB_PASSWORD}'"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dischargeloop_app') THEN
    CREATE ROLE dischargeloop_app LOGIN ${app_pw_clause} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dischargeloop_migrator') THEN
    CREATE ROLE dischargeloop_migrator LOGIN ${mig_pw_clause} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
\$\$;

-- Extensions need superuser; install once into public so migrations can rely on them.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO dischargeloop_app, dischargeloop_migrator;

CREATE SCHEMA IF NOT EXISTS dischargeloop AUTHORIZATION dischargeloop_migrator;
CREATE SCHEMA IF NOT EXISTS medsync AUTHORIZATION dischargeloop_migrator;
GRANT USAGE ON SCHEMA dischargeloop, medsync TO dischargeloop_app;

ALTER DEFAULT PRIVILEGES FOR ROLE dischargeloop_migrator IN SCHEMA dischargeloop
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dischargeloop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dischargeloop_migrator IN SCHEMA dischargeloop
  GRANT USAGE, SELECT ON SEQUENCES TO dischargeloop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dischargeloop_migrator IN SCHEMA medsync
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dischargeloop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dischargeloop_migrator IN SCHEMA medsync
  GRANT USAGE, SELECT ON SEQUENCES TO dischargeloop_app;

ALTER ROLE dischargeloop_app SET search_path = dischargeloop, medsync, public;
ALTER ROLE dischargeloop_migrator SET search_path = dischargeloop, medsync, public;
SQL

echo "Database roles created."

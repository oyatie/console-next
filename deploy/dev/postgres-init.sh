#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Fresh-volume bootstrap of the role contracts in backend/app/src/state/db/.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=db="$POSTGRES_DB" \
  --set=app_password="$CONSOLE_APP_POSTGRES_PASSWORD" \
  --set=rt_password="$CONSOLE_RT_POSTGRES_PASSWORD" \
  --set=leave_password="$CONSOLE_LEAVE_COMMAND_POSTGRES_PASSWORD" \
  --set=ontology_password="$CONSOLE_ONTOLOGY_COMMAND_POSTGRES_PASSWORD" \
  --set=force_password="$CONSOLE_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD" <<'SQL'
CREATE ROLE console_app LOGIN INHERIT NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
CREATE ROLE console_rt LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'rt_password';
CREATE ROLE console_leave_cmd LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'leave_password';
CREATE ROLE console_ontology_cmd LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'ontology_password';
CREATE ROLE console_platform_force_cmd LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'force_password';
CREATE ROLE console_leave_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE console_ontology_writer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE console_auth_cmd NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT console_leave_definer, console_ontology_writer TO console_app WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
ALTER DATABASE :"db" OWNER TO console_app;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO console_rt, console_leave_cmd, console_ontology_cmd, console_platform_force_cmd;
-- Serving-pool readback rejects missing budgets, including after RESET ALL.
SELECT format('ALTER ROLE %I SET %I = %L', role_name, setting, value)
FROM unnest(ARRAY['console_rt', 'console_leave_cmd', 'console_ontology_cmd', 'console_platform_force_cmd']) AS role_name
CROSS JOIN (VALUES ('statement_timeout', '30s'), ('idle_in_transaction_session_timeout', '30s'), ('transaction_timeout', '45s')) AS budgets(setting, value)
\gexec
SQL

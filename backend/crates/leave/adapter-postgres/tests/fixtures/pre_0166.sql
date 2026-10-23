-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Remove later Person compatibility hooks before rehearsing only shipped 0166.
DROP VIEW person_employees_current;
DROP TRIGGER person_bind_account ON users;
DROP TRIGGER person_account_initial_facts ON users;
DROP TRIGGER person_bind_import_employee ON employees;
DROP TRIGGER person_employee_facts ON employees;
DROP TRIGGER person_employee_phone ON employee_employment_profiles;
DROP TRIGGER person_sync_employee_accounts ON employee_person_bindings;
DROP TRIGGER IF EXISTS check_person_fact_constraints ON users;
DROP TRIGGER IF EXISTS check_person_fact_constraints ON employees;
DROP TRIGGER IF EXISTS check_person_fact_constraints ON employee_employment_profiles;
ALTER TABLE users DROP CONSTRAINT users_principal_person_check;

DROP SCHEMA leave_api CASCADE;
DROP TABLE leave_balance_import_receipts CASCADE;
DROP TABLE leave_charge_resolutions CASCADE;
DROP FUNCTION leave_charge_resolutions_immutable();
DROP FUNCTION leave_requests_intent_routing_immutable() CASCADE;
DROP FUNCTION leave_requests_charge_pointer_consistent() CASCADE;

DROP INDEX employees_org_home_branch_idx;
ALTER TABLE employees
    DROP CONSTRAINT employees_home_branch_same_org_fk,
    DROP CONSTRAINT employees_id_org_id_unique,
    DROP COLUMN home_branch_id,
    ALTER COLUMN leave_accrued TYPE NUMERIC(10,2),
    ALTER COLUMN leave_used TYPE NUMERIC(10,2),
    ALTER COLUMN leave_remaining TYPE NUMERIC(10,2);

ALTER TABLE leave_requests
    DROP CONSTRAINT IF EXISTS leave_requests_current_charge_resolution_fk,
    DROP CONSTRAINT leave_requests_submission_pair,
    DROP CONSTRAINT leave_requests_status_charge_state,
    DROP CONSTRAINT leave_requests_charge_review_reason_values,
    DROP CONSTRAINT leave_requests_partial_day_shape,
    DROP CONSTRAINT leave_requests_charge_shape,
    DROP CONSTRAINT leave_requests_org_id_id_unique,
    DROP COLUMN current_charge_resolution_id,
    DROP COLUMN charge_version,
    DROP COLUMN request_version,
    DROP COLUMN charge_units,
    DROP COLUMN submission_initial_charge_version,
    DROP COLUMN submission_digest,
    DROP COLUMN submission_key,
    DROP COLUMN charge_review_reasons,
    DROP COLUMN charge_state,
    DROP COLUMN partial_day_period,
    DROP COLUMN legacy_days,
    ALTER COLUMN days TYPE NUMERIC(4,1),
    ALTER COLUMN days SET NOT NULL;

ALTER ROLE console_app LOGIN INHERIT NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE
    NOREPLICATION PASSWORD 'leave-migration-owner-a166';
ALTER ROLE console_leave_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
    NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE console_leave_cmd LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
    NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE console_leave_definer FROM console_rt, console_leave_cmd;
REVOKE console_rt, console_leave_cmd FROM console_app, console_leave_definer;
GRANT console_leave_definer TO console_app
    WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;

DO $db_owner$
BEGIN
    EXECUTE format('ALTER DATABASE %I OWNER TO console_app', current_database());
END
$db_owner$;

ALTER TABLE organizations OWNER TO console_app;
ALTER TABLE users OWNER TO console_app;
ALTER TABLE user_branches OWNER TO console_app;
ALTER TABLE regions OWNER TO console_app;
ALTER TABLE branches OWNER TO console_app;
ALTER TABLE employees OWNER TO console_app;
ALTER TABLE leave_requests OWNER TO console_app;
ALTER TABLE data_import_runs OWNER TO console_app;
ALTER TABLE data_import_rows OWNER TO console_app;
ALTER TABLE audit_events OWNER TO console_app;
ALTER TABLE policy_roles OWNER TO console_app;
ALTER TABLE policy_role_permissions OWNER TO console_app;
ALTER TABLE policy_role_conditions OWNER TO console_app;
ALTER TABLE user_role_assignments OWNER TO console_app;

REVOKE ALL ON leave_requests FROM PUBLIC, console_rt, console_leave_cmd, console_leave_definer;
GRANT SELECT, INSERT, UPDATE ON leave_requests TO console_rt;

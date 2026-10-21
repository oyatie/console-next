-- Employee lifecycle Stage D.
--
-- 1. ON_LEAVE joins the employment status vocabulary (employees head and the
--    lifecycle ledger's to_status). Readers filtering `= 'ACTIVE'` (headcount,
--    reassignment fan-out, absence materializer) deliberately exclude it.
-- 2. Four new lifecycle event types: PROMOTE, LEAVE_OF_ABSENCE,
--    RETURN_FROM_LEAVE, CONTRACT_RENEWAL, with their typed payload columns.
-- 3. A generic, tenant-isolated Idempotency-Key reservation ledger for create
--    endpoints that have no natural idempotency column of their own. The
--    stored response is what an exact replay returns.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_employment_status_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_status_check
    CHECK (employment_status IN ('ACTIVE', 'ON_LEAVE', 'EXITED', 'UNKNOWN'));

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_to_status_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_to_status_check
    CHECK (to_status IN ('ACTIVE', 'ON_LEAVE', 'EXITED', 'UNKNOWN'));

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_event_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_event_type_check
    CHECK (event_type IN (
        'ONBOARD', 'OFFBOARD', 'TERMINATE', 'TRANSFER',
        'PROMOTE', 'LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'CONTRACT_RENEWAL'
    ));

ALTER TABLE employee_lifecycle_events
    ADD COLUMN expected_return_date DATE NULL,
    ADD COLUMN contract_end_date DATE NULL;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_contract_end_date_check
    CHECK ((event_type = 'CONTRACT_RENEWAL') = (contract_end_date IS NOT NULL));
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_expected_return_date_check
    CHECK (expected_return_date IS NULL OR event_type = 'LEAVE_OF_ABSENCE');

COMMENT ON COLUMN employee_lifecycle_events.expected_return_date IS 'pd:personal — planned return from a leave of absence; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.contract_end_date IS 'pd:personal — renewed fixed-term contract end date; 개보법 제2조제1호나목 결합 식별';

CREATE TABLE api_idempotency_keys (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    operation           TEXT        NOT NULL CHECK (operation IN (
                            'users.create', 'employee.lifecycle.create', 'hr.exit_case.create'
                        )),
    idempotency_key     TEXT        NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint TEXT        NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    response            JSONB       NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, operation, idempotency_key)
);

ALTER TABLE api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON api_idempotency_keys
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);
REVOKE ALL PRIVILEGES ON api_idempotency_keys FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE (response, completed_at) ON api_idempotency_keys TO console_rt;
CREATE TRIGGER trg_api_idempotency_keys_org_immutable
    BEFORE UPDATE ON api_idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

COMMENT ON TABLE api_idempotency_keys IS 'Idempotency-Key reservations; response is replayed verbatim for an exact retry';
COMMENT ON COLUMN api_idempotency_keys.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN api_idempotency_keys.operation IS 'pd:none — endpoint discriminator';
COMMENT ON COLUMN api_idempotency_keys.idempotency_key IS 'pd:none — client-chosen opaque retry key';
COMMENT ON COLUMN api_idempotency_keys.request_fingerprint IS 'pd:none — SHA-256 of the canonical request';
COMMENT ON COLUMN api_idempotency_keys.response IS 'pd:personal — replayed response body (user / employee / exit-case record)';
COMMENT ON COLUMN api_idempotency_keys.created_at IS 'pd:none — reservation time';
COMMENT ON COLUMN api_idempotency_keys.completed_at IS 'pd:none — completion time';

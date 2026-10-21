-- People journeys: contract dates, leave type, bulk appointments.
--
-- 1. A fixed-term (CONTRACT) employment carries its contract window on the
--    employment profile: set at registration, moved by CONTRACT_RENEWAL (the
--    only column console_rt may UPDATE there).
-- 2. LEAVE_OF_ABSENCE may name its leave type.
-- 3. A bulk appointment stamps every lifecycle event it records with one
--    batch id, and its Idempotency-Key joins the reservation ledger.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_employment_profiles
    ADD COLUMN contract_start_date DATE NULL,
    ADD COLUMN contract_end_date DATE NULL;
ALTER TABLE employee_employment_profiles ADD CONSTRAINT employee_employment_profiles_contract_dates_check
    CHECK (contract_start_date IS NULL OR contract_end_date IS NULL OR contract_start_date <= contract_end_date);
CREATE INDEX employee_employment_profiles_org_contract_end_idx
    ON employee_employment_profiles (org_id, contract_end_date)
    WHERE contract_end_date IS NOT NULL;
GRANT UPDATE (contract_end_date) ON employee_employment_profiles TO console_rt;

COMMENT ON COLUMN employee_employment_profiles.contract_start_date IS 'pd:personal — fixed-term contract start date; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_employment_profiles.contract_end_date IS 'pd:personal — current fixed-term contract end date; 개보법 제2조제1호나목 결합 식별';

ALTER TABLE employee_lifecycle_events
    ADD COLUMN leave_type TEXT NULL
        CHECK (leave_type IS NULL OR leave_type IN ('CHILDCARE', 'MATERNITY', 'ILLNESS', 'PERSONAL', 'OTHER')),
    ADD COLUMN batch_id UUID NULL;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_leave_type_event_check
    CHECK (leave_type IS NULL OR event_type = 'LEAVE_OF_ABSENCE');
CREATE INDEX employee_lifecycle_events_org_batch_idx
    ON employee_lifecycle_events (org_id, batch_id)
    WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN employee_lifecycle_events.leave_type IS 'pd:personal,sensitive/health — leave-of-absence type; ILLNESS and MATERNITY reveal health (개보법 제23조)';
COMMENT ON COLUMN employee_lifecycle_events.batch_id IS 'pd:none — bulk appointment batch that recorded the event';

ALTER TABLE api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk'
    ));

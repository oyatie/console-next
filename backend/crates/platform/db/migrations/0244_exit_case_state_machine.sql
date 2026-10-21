-- Exit cases: a closed state machine with a compensating reversal.
--
-- 1. HR confirmation records the TERMINATE lifecycle event that exits the
--    employee; the case keeps that event's id so a later REJECT/CANCEL can
--    reverse exactly that effect.
-- 2. REJECTED/CANCELLED record who closed the case, when, and why.
-- 3. EXIT_REVERSAL joins the lifecycle vocabulary: the compensating event that
--    restores the status the exit replaced (EXITED -> prior status).
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_exit_cases
    -- SET NULL: tenant force-removal deletes lifecycle events before the
    -- employees whose cascade removes exit cases.
    ADD COLUMN exit_lifecycle_event_id UUID NULL
        REFERENCES employee_lifecycle_events(id) ON DELETE SET NULL,
    ADD COLUMN closed_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN closed_at TIMESTAMPTZ NULL,
    ADD COLUMN closed_reason TEXT NULL
        CHECK (closed_reason IS NULL OR (btrim(closed_reason) <> '' AND char_length(closed_reason) <= 1000));
ALTER TABLE employee_exit_cases ADD CONSTRAINT employee_exit_cases_closed_check
    CHECK (closed_at IS NULL OR status IN ('REJECTED', 'CANCELLED'));

-- A rejected or cancelled case settles nothing: closing it deletes its
-- settlement package (and any drafted approval payload) in the same audited
-- transaction.
GRANT DELETE ON employee_exit_settlement_packages TO console_rt;

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_event_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_event_type_check
    CHECK (event_type IN (
        'ONBOARD', 'OFFBOARD', 'TERMINATE', 'TRANSFER',
        'PROMOTE', 'LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'CONTRACT_RENEWAL',
        'EXIT_REVERSAL'
    ));

COMMENT ON COLUMN employee_exit_cases.exit_lifecycle_event_id IS 'pd:none — lifecycle event the HR confirmation recorded; reversed on reject/cancel';
COMMENT ON COLUMN employee_exit_cases.closed_by IS 'pd:personal — user who rejected or cancelled the case';
COMMENT ON COLUMN employee_exit_cases.closed_at IS 'pd:none — rejection/cancellation time';
COMMENT ON COLUMN employee_exit_cases.closed_reason IS 'pd:personal — rejection/cancellation reason (free text about the employee)';

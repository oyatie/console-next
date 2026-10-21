-- Effective-dated (scheduled) personnel actions.
--
-- 1. A lifecycle event dated after today (KST) is stored SCHEDULED and applied
--    on its date (APPLIED), refused at apply time (APPLY_FAILED, with the
--    refusal), or withdrawn before it (CANCELLED, by hand or superseded by a
--    correction for the same kind and date). Every pre-existing row and every
--    immediate event is APPLIED.
-- 2. The ledger stays append-only for facts: only a SCHEDULED row may change,
--    and only its state/outcome columns plus the from/to projection its apply
--    rewrites. A row that left SCHEDULED is final.
-- 3. One SCHEDULED event of a kind per employee per date.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_lifecycle_events
    ADD COLUMN state TEXT NOT NULL DEFAULT 'APPLIED'
        CHECK (state IN ('SCHEDULED', 'APPLIED', 'APPLY_FAILED', 'CANCELLED')),
    ADD COLUMN scheduled_request JSONB NULL,
    ADD COLUMN applied_at TIMESTAMPTZ NULL,
    ADD COLUMN failure_code TEXT NULL,
    ADD COLUMN failure_reason TEXT NULL,
    ADD COLUMN cancelled_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN cancelled_at TIMESTAMPTZ NULL,
    ADD COLUMN cancel_reason TEXT NULL
        CHECK (cancel_reason IS NULL OR (btrim(cancel_reason) <> '' AND char_length(cancel_reason) <= 1000)),
    -- No FK: the replaced row is finalized before its replacement is inserted.
    ADD COLUMN superseded_by UUID NULL;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_failure_check
    CHECK ((state = 'APPLY_FAILED') = (failure_code IS NOT NULL));
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_cancel_check
    CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL));

CREATE UNIQUE INDEX employee_lifecycle_events_one_scheduled_idx
    ON employee_lifecycle_events (org_id, employee_id, event_type, effective_date)
    WHERE state = 'SCHEDULED';
CREATE INDEX employee_lifecycle_events_due_idx
    ON employee_lifecycle_events (org_id, effective_date)
    WHERE state = 'SCHEDULED';

CREATE OR REPLACE FUNCTION employee_lifecycle_events_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.state = 'SCHEDULED'
       AND NEW.id = OLD.id
       AND NEW.org_id = OLD.org_id
       AND NEW.employee_id = OLD.employee_id
       AND NEW.event_type = OLD.event_type
       AND NEW.effective_date = OLD.effective_date
       AND NEW.created_by = OLD.created_by
       AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'employee_lifecycle_events is append-only: % is forbidden (row id=%)',
        TG_OP, OLD.id
        USING ERRCODE = '55000';
END;
$$;

GRANT UPDATE (
    state, applied_at, failure_code, failure_reason,
    cancelled_by, cancelled_at, cancel_reason, superseded_by,
    from_status, to_status, from_company, to_company,
    from_org_unit, to_org_unit, from_position, to_position
) ON employee_lifecycle_events TO console_rt;

COMMENT ON COLUMN employee_lifecycle_events.state IS 'pd:none — SCHEDULED, APPLIED, APPLY_FAILED, or CANCELLED';
COMMENT ON COLUMN employee_lifecycle_events.scheduled_request IS 'pd:personal — the normalized scheduled change (positions, units, dates, leave type) re-validated on its date';
COMMENT ON COLUMN employee_lifecycle_events.applied_at IS 'pd:none — when a scheduled event was applied';
COMMENT ON COLUMN employee_lifecycle_events.failure_code IS 'pd:none — refusal code when a scheduled event could not be applied';
COMMENT ON COLUMN employee_lifecycle_events.failure_reason IS 'pd:none — server-authored refusal message when a scheduled event could not be applied';
COMMENT ON COLUMN employee_lifecycle_events.cancelled_by IS 'pd:personal — user who cancelled the scheduled event';
COMMENT ON COLUMN employee_lifecycle_events.cancelled_at IS 'pd:none — cancellation time';
COMMENT ON COLUMN employee_lifecycle_events.cancel_reason IS 'pd:personal — cancellation reason (free text about the employee)';
COMMENT ON COLUMN employee_lifecycle_events.superseded_by IS 'pd:none — the scheduled event that replaced this one for the same kind and date';

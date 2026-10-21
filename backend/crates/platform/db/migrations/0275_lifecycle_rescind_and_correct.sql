-- BW-11: correction (정정) and rescission (취소·철회) of an APPLIED lifecycle
-- event, kept append-only. Numbered head+1 of hard/life/bw11 (0258); INTEG
-- renumbers at the batch merge. head_version (the version pin) is EMP-MODEL's
-- 0256 column; no column for it here.
--
-- Deviation from the BW-11 text, on purpose: the spec names both
-- voids_event_id (new row) and voided_by_event_id (old row), and says the
-- append-only trigger stays. Writing voided_by_event_id would UPDATE an
-- APPLIED row, which the 0246 trigger forbids. So only the NEW row carries
-- the link (voids_event_id); "voided by" is read by joining on it. A unique
-- index makes "an event is voided at most once" a database fact.
--
--   * a correction appends the replacement, of the original's type and date,
--     with voids_event_id = the original;
--   * a rescission appends a RESCIND row (the head restored to the original's
--     from_ values, like EXIT_REVERSAL) with voids_event_id = the original.
-- Restoring needs the two from_ facts no column held: the OrgUnit binding
-- (a TRANSFER rebinds; from_org_unit is only the name) and the contract end
-- a CONTRACT_RENEWAL moved. Recorded at record time; a scheduled event keeps
-- its schedule-time values (0246's column grant lets the runner rewrite only
-- the text projections).
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_lifecycle_events
    ADD COLUMN from_org_unit_id UUID NULL,
    ADD COLUMN from_contract_end_date DATE NULL,
    ADD COLUMN voids_event_id UUID NULL
        CONSTRAINT employee_lifecycle_events_voids_fk REFERENCES employee_lifecycle_events (id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_voids_not_self CHECK (voids_event_id <> id);
CREATE UNIQUE INDEX employee_lifecycle_events_voids_once_idx
    ON employee_lifecycle_events (voids_event_id) WHERE voids_event_id IS NOT NULL;

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_event_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_event_type_check
    CHECK (event_type IN (
        'ONBOARD', 'OFFBOARD', 'TERMINATE', 'TRANSFER',
        'PROMOTE', 'LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'CONTRACT_RENEWAL',
        'EXIT_REVERSAL', 'REHIRE', 'RESCIND'
    ));
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_rescind_voids
    CHECK (event_type <> 'RESCIND' OR voids_event_id IS NOT NULL);

COMMENT ON COLUMN employee_lifecycle_events.from_org_unit_id IS 'pd:personal — OrgUnit binding before the event (restored by a rescission); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_contract_end_date IS 'pd:personal — contract end before a CONTRACT_RENEWAL (restored by a rescission); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.voids_event_id IS 'pd:none — the APPLIED event this row corrects (same type and date) or rescinds (event_type RESCIND); each event is voided at most once';

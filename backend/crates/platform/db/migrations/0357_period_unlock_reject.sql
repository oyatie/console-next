-- BW-15 second-person unlock: the second person may refuse the request
-- (반려) with a note, and the lock page and the subscribers' streams learn of
-- every unlock decision. Head+1 of dev; INTEG renumbers.
SET LOCAL lock_timeout = '2s';

ALTER TABLE period_unlock_requests
    ADD COLUMN decision_note TEXT NULL
        CHECK (decision_note IS NULL OR (btrim(decision_note) <> '' AND char_length(decision_note) <= 1000)),
    DROP CONSTRAINT period_unlock_requests_outcome_check,
    ADD CONSTRAINT period_unlock_requests_outcome_check
        CHECK (outcome IN ('APPROVED', 'REJECTED', 'SUPERSEDED')),
    DROP CONSTRAINT period_unlock_requests_decision,
    ADD CONSTRAINT period_unlock_requests_decision CHECK (
        (outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL AND decision_note IS NULL)
        OR (outcome = 'SUPERSEDED' AND decided_at IS NOT NULL AND decision_note IS NULL)
        OR (outcome = 'APPROVED' AND decided_at IS NOT NULL
            AND decided_by IS NOT NULL AND decided_by <> requested_by AND decision_note IS NULL)
        OR (outcome = 'REJECTED' AND decided_at IS NOT NULL AND decision_note IS NOT NULL
            AND decided_by IS NOT NULL AND decided_by <> requested_by)
    );

-- A refusal replays by its Idempotency-Key like the other unlock commands.
ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check,
    ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
        'period_lock.unlock_reject',
        'employee.correction.bulk',
        'appointment_notice.issue'
    ));

-- outcome and decided_by keep their 0280 classification; REJECTED joins the outcome CHECK above.
COMMENT ON COLUMN period_unlock_requests.decision_note IS
    'pd:personal — why the second person refused the unlock (free text, may name people)';

-- Unlock requests and their decisions refresh every close authority's lock list and Home.
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('period_lock', 'period_lock.lock', 'period_lock', true),
    ('period_lock', 'period_lock.relock', 'period_lock', true),
    ('period_lock', 'period_lock.unlock', 'period_lock', true),
    ('period_lock', 'period_lock.unlock_request', 'period_lock', true),
    ('period_lock', 'period_lock.unlock_reject', 'period_lock', true);

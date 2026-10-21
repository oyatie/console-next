-- PREREG-1: the one shared pre-registration migration (concurrency plan §3).
--
-- Contents, each owned here so no lane edits the shared object again:
--   1. feature_catalog rows for the 8 features PREREG-2 adds to `Feature`.
--   2. REHIRE (event type) and PRE_HIRE (status) in the employee CHECKs, so
--      LIFE (BW-11/13) and IMPORT (BW-19) never both rewrite one CHECK.
--   3. period_lock_effective(): N11's SQL, spliced in verbatim (see §3).
SET LOCAL lock_timeout = '2s';

-- 1. Feature catalog rows (concurrency challenge C6).
--
-- Reference data, not seed rows: a row makes a feature grantable, it grants
-- nothing (see 0209). Landing the rows ahead of the enum is safe:
-- feature_catalog_covers_every_feature asserts only Feature -> row.
-- PREREG-2's `Feature::as_str` arms MUST equal these keys byte for byte:
--   SettingsManage      settings_manage          BW-00
--   ReasonCodeManage    reason_code_manage       BW-07
--   ExceptionDecide     exception_decide         BW-06
--   ApprovalRouteManage approval_route_manage    BW-01
--   ChangeRequestDecide change_request_decide    BW-17
--   JobTitleManage      job_title_manage         BW-13
--   RetainedRecordsRead retained_records_read    BW-36 (deferred, OD-7; inert)
--   TenantOffboard      tenant_offboard          BW-36 (deferred, OD-7; inert)
INSERT INTO feature_catalog (feature_key) VALUES
    ('approval_route_manage'),
    ('change_request_decide'),
    ('exception_decide'),
    ('job_title_manage'),
    ('reason_code_manage'),
    ('retained_records_read'),
    ('settings_manage'),
    ('tenant_offboard')
ON CONFLICT (feature_key) DO NOTHING;

-- 2. REHIRE / PRE_HIRE.
--
-- REHIRE starts a new employment period for an EXITED person (BW-19 2).
-- PRE_HIRE is the head status of an employee created with a future hire date
-- and a SCHEDULED ONBOARD (BW-19 4). As in 0243, the lifecycle ledger's
-- to_status mirrors the head vocabulary. Lists below are 0243/0244 plus the
-- new value; nothing is removed.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_employment_status_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_status_check
    CHECK (employment_status IN ('PRE_HIRE', 'ACTIVE', 'ON_LEAVE', 'EXITED', 'UNKNOWN'));

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_to_status_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_to_status_check
    CHECK (to_status IN ('PRE_HIRE', 'ACTIVE', 'ON_LEAVE', 'EXITED', 'UNKNOWN'));

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_event_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_event_type_check
    CHECK (event_type IN (
        'ONBOARD', 'OFFBOARD', 'TERMINATE', 'TRANSFER',
        'PROMOTE', 'LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'CONTRACT_RENEWAL',
        'EXIT_REVERSAL', 'REHIRE'
    ));

-- 3. period_lock_effective() (BW-15, decisions #8b).
--
-- From drafts/migrations/lockfn.sql (N11, hard/found/lockfn), spliced verbatim;
-- it also adds period_locks.relock_at and swaps the partial index.
-- N11 (BW-15, decisions.md #8b as amended by decisions-data-periods-challenge
-- Q8b breaks 1-2): one effective-lock predicate for `period_locks`.
-- Ships inside the PREREG-1 migration; INTEG assigns the number.
--
-- Semantics. A lock row is effective iff it was never unlocked, or its unlock
-- window has expired (`relock_at <= now()`) and no successor row exists for
-- the same (org_id, domain, period_start, period_end) locked after the
-- unlock. The re-lock scheduler appends that successor (rows stay append-only,
-- MIG/0107); if the scheduler is down the expired row stays effective, so the
-- period fails closed without becoming un-unlockable.
--
-- Every reader must use this function instead of spelling the predicate
-- inline: `WHERE period_lock_effective(period_locks)` or, with an alias,
-- `WHERE period_lock_effective(pl)`. tools/ci/check-period-lock-predicate.mjs
-- fails CI on any inline copy outside this function body.
--
-- Behaviour preserved for existing rows: `relock_at` is NULL on every row
-- unlocked before BW-15, so such a row stays permanently unlocked exactly as
-- today. BW-15 (LOCK lane) adds `unlock_approved_by`, the scheduler and the
-- unlock API; it must not re-add `relock_at`.

ALTER TABLE period_locks
    ADD COLUMN relock_at TIMESTAMPTZ NULL,
    ADD CONSTRAINT period_locks_relock_after_unlock CHECK (
        relock_at IS NULL
        OR (unlocked_at IS NOT NULL AND relock_at > unlocked_at)
    );
COMMENT ON COLUMN period_locks.relock_at IS 'pd:none — end of a time-boxed unlock window, structural';

CREATE OR REPLACE FUNCTION period_lock_effective(p period_locks)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT p.unlocked_at IS NULL
        OR (
            coalesce(p.relock_at <= now(), false)
            AND NOT EXISTS (
                SELECT 1 FROM period_locks s
                WHERE s.org_id = p.org_id
                  AND s.domain = p.domain
                  AND s.period_start = p.period_start
                  AND s.period_end = p.period_end
                  AND s.locked_at > p.unlocked_at
            )
        )
$$;

REVOKE ALL ON FUNCTION period_lock_effective(period_locks) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION period_lock_effective(period_locks) TO console_rt;

-- The partial index only covered never-unlocked rows, so it cannot serve the
-- effective predicate (an expired unlock is effective too). One non-partial
-- index serves both the range lookups and the successor probe above.
DROP INDEX idx_period_locks_active;
CREATE INDEX idx_period_locks_span
    ON period_locks (org_id, domain, period_start, period_end);

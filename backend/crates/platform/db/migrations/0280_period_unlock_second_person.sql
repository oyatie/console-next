-- BW-15 (decisions #8b and the BW-15 amendments): a period unlock needs a
-- step-up (PERIOD_UNLOCK, 0254) and a second person when another eligible
-- holder exists (D0.2); a sole holder unlocks alone and the row carries the
-- review flag (the #7 fallback). Numbered head+1 of the lane's base; INTEG
-- renumbers. `relock_at` and `period_lock_effective()` came with 0248; the
-- scoped unlock (`scope_employee_id`) was dropped by the BW-15 amendment.
--
-- The unlock stays the one-shot UPDATE of `period_locks` (0107 trigger). A
-- request waiting for its second person cannot live on the lock row, because
-- that trigger refuses every UPDATE except the unlock itself, so it lives in
-- `period_unlock_requests` until the approver performs the unlock.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Who approved the unlock, with which step-up, and whether it needs review.
-- ---------------------------------------------------------------------------
ALTER TABLE period_locks
    ADD COLUMN unlock_approved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN unlock_step_up_assertion_id UUID NULL,
    ADD COLUMN unlock_review_required BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT period_locks_unlock_second_person CHECK (
        unlock_approved_by IS NULL OR unlock_approved_by <> unlocked_by
    );
COMMENT ON COLUMN period_locks.unlock_approved_by IS
    'pd:personal — the second person who approved the unlock; NULL for a sole-holder unlock';
COMMENT ON COLUMN period_locks.unlock_step_up_assertion_id IS
    'pd:none — step_up_assertions.ceremony_id of the act that performed the unlock';
COMMENT ON COLUMN period_locks.unlock_review_required IS
    'pd:none — sole-holder unlock (no other eligible holder): flagged for review (decisions #7)';

-- ---------------------------------------------------------------------------
-- 2. Unlock requests waiting for a second person.
-- ---------------------------------------------------------------------------
-- console-gate: audited-table period_unlock_requests
CREATE TABLE period_unlock_requests (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lock_id              UUID        NOT NULL,
    requested_by         UUID        NOT NULL,
    reason_code          TEXT        NOT NULL CHECK (reason_code_well_formed(reason_code)),
    reason_note          TEXT        NULL
        CHECK (reason_note IS NULL OR (btrim(reason_note) <> '' AND char_length(reason_note) <= 1000)),
    relock_at            TIMESTAMPTZ NOT NULL,
    step_up_assertion_id UUID        NOT NULL,
    requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome              TEXT        NULL CHECK (outcome IN ('APPROVED', 'SUPERSEDED')),
    decided_by           UUID        NULL,
    decided_at           TIMESTAMPTZ NULL,
    UNIQUE (id, org_id),
    FOREIGN KEY (lock_id, org_id) REFERENCES period_locks(id, org_id) ON DELETE CASCADE,
    CONSTRAINT period_unlock_requests_relock_after_request CHECK (relock_at > requested_at),
    CONSTRAINT period_unlock_requests_decision CHECK (
        (outcome IS NULL AND decided_by IS NULL AND decided_at IS NULL)
        OR (outcome = 'SUPERSEDED' AND decided_at IS NOT NULL)
        OR (outcome = 'APPROVED' AND decided_at IS NOT NULL
            AND decided_by IS NOT NULL AND decided_by <> requested_by)
    )
);

-- One open request per lock: a new request supersedes the open one.
CREATE UNIQUE INDEX period_unlock_requests_one_open
    ON period_unlock_requests (org_id, lock_id) WHERE outcome IS NULL;

-- A request is decided once; only the decision columns move.
CREATE OR REPLACE FUNCTION period_unlock_requests_decide_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'period unlock request % is already decided', OLD.id
            USING ERRCODE = '25006';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.lock_id IS DISTINCT FROM OLD.lock_id
        OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
        OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
        OR NEW.reason_note IS DISTINCT FROM OLD.reason_note
        OR NEW.relock_at IS DISTINCT FROM OLD.relock_at
        OR NEW.step_up_assertion_id IS DISTINCT FROM OLD.step_up_assertion_id
        OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    THEN
        RAISE EXCEPTION 'period unlock requests only permit the one-shot decision'
            USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_period_unlock_requests_decide_once
    BEFORE UPDATE ON period_unlock_requests
    FOR EACH ROW EXECUTE FUNCTION period_unlock_requests_decide_once();
CREATE TRIGGER trg_period_unlock_requests_org_immutable BEFORE UPDATE ON period_unlock_requests
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE period_unlock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_unlock_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON period_unlock_requests
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL PRIVILEGES ON period_unlock_requests FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON period_unlock_requests TO console_rt;

COMMENT ON TABLE period_unlock_requests IS
    'BW-15 period unlock waiting for its second person; the approver performs the unlock';
COMMENT ON COLUMN period_unlock_requests.id IS 'pd:none — request id';
COMMENT ON COLUMN period_unlock_requests.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN period_unlock_requests.lock_id IS 'pd:none — the period lock to unlock';
COMMENT ON COLUMN period_unlock_requests.requested_by IS
    'pd:personal — user who requested the unlock; logical ref, survives account removal';
COMMENT ON COLUMN period_unlock_requests.reason_code IS 'pd:none — period_unlock reason code (0252)';
COMMENT ON COLUMN period_unlock_requests.reason_note IS 'pd:personal — optional requester note (free text, may name people)';
COMMENT ON COLUMN period_unlock_requests.relock_at IS 'pd:none — requested end of the unlock window';
COMMENT ON COLUMN period_unlock_requests.step_up_assertion_id IS
    'pd:none — step_up_assertions.ceremony_id of the requester''s step-up';
COMMENT ON COLUMN period_unlock_requests.requested_at IS 'pd:none — request time';
COMMENT ON COLUMN period_unlock_requests.outcome IS 'pd:none — APPROVED or SUPERSEDED; NULL while open';
COMMENT ON COLUMN period_unlock_requests.decided_by IS
    'pd:personal — the approver, or the requester of the superseding request; logical ref';
COMMENT ON COLUMN period_unlock_requests.decided_at IS 'pd:none — decision time';

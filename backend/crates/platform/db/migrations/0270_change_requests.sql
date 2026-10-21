-- BW-17: change request (변경 요청), a governed request to HR with an assignee.
--
-- Kinds: PROFILE_CORRECTION (applied through BW-18), IDENTITY_REVIEW,
-- ACCESS_REQUEST, SCOPE_ACTION (a branch admin asks HR to act) and OTHER (the
-- unforeseen case: a note is required and the row is flagged for review).
--
-- The requester never decides: CHECK decided_by <> requested_by is the DB
-- backstop of the hr-domain rule. WITHDRAWN is the requester's own close and
-- carries no decider. No seed rows; reason codes are checked for shape only
-- (the BW-07 catalog validates them in the application).
--
-- Request columns never change after insert (column-level GRANT); the one-shot
-- OPEN -> APPLIED | DECLINED | WITHDRAWN close is enforced by trigger. console_rt
-- has no DELETE; tenant removal deletes through the RESTRICT org_id FK sweep.
SET LOCAL lock_timeout = '2s';

CREATE TABLE change_requests (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    kind                 TEXT        NOT NULL CHECK (kind IN (
                             'PROFILE_CORRECTION', 'IDENTITY_REVIEW', 'ACCESS_REQUEST',
                             'SCOPE_ACTION', 'OTHER'
                         )),
    subject_type         TEXT        NOT NULL CHECK (subject_type IN (
                             'EMPLOYEE', 'USER_ACCOUNT', 'BRANCH', 'ORGANIZATION'
                         )),
    subject_id           UUID        NOT NULL,
    payload              JSONB       NOT NULL DEFAULT '{}'::jsonb
                             CHECK (jsonb_typeof(payload) = 'object'),
    reason_code          TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    note                 TEXT        NULL
                             CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)),
    requested_by         UUID        NOT NULL,
    assignee_role        TEXT        NOT NULL CHECK (assignee_role IN ('HR')),
    assignee_user_id     UUID        NULL,
    status               TEXT        NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN', 'APPLIED', 'DECLINED', 'WITHDRAWN')),
    decided_by           UUID        NULL,
    decision_reason_code TEXT        NULL CHECK (decision_reason_code IS NULL
                             OR char_length(btrim(decision_reason_code)) BETWEEN 1 AND 100),
    decision_note        TEXT        NULL CHECK (decision_note IS NULL
                             OR (btrim(decision_note) <> '' AND char_length(decision_note) <= 1000)),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at           TIMESTAMPTZ NULL,
    UNIQUE (id, org_id),
    FOREIGN KEY (requested_by, org_id)     REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (assignee_user_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (decided_by, org_id)       REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT change_requests_no_self_decision
        CHECK (decided_by IS NULL OR decided_by <> requested_by),
    CONSTRAINT change_requests_other_needs_note CHECK (kind <> 'OTHER' OR note IS NOT NULL),
    -- Closed iff decided_at; decided (APPLIED/DECLINED) iff a decider and a reason.
    CONSTRAINT change_requests_decision_shape CHECK (
        (status = 'OPEN') = (decided_at IS NULL)
        AND (status IN ('APPLIED', 'DECLINED')) = (decided_by IS NOT NULL)
        AND (decided_by IS NULL) = (decision_reason_code IS NULL)
        AND (decided_at IS NOT NULL OR decision_note IS NULL)
    ),
    CONSTRAINT change_requests_decided_after_creation
        CHECK (decided_at IS NULL OR decided_at >= created_at)
);

CREATE INDEX change_requests_org_status_idx
    ON change_requests (org_id, status, created_at);
CREATE INDEX change_requests_org_requester_idx
    ON change_requests (org_id, requested_by, created_at);
CREATE INDEX change_requests_org_subject_idx
    ON change_requests (org_id, subject_type, subject_id);

CREATE FUNCTION change_requests_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'change_requests % is already closed (%)', OLD.id, OLD.status;
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON change_requests
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_change_requests_org_immutable BEFORE UPDATE ON change_requests
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_change_requests_close_once BEFORE UPDATE ON change_requests
    FOR EACH ROW EXECUTE FUNCTION change_requests_close_once();

REVOKE ALL PRIVILEGES ON change_requests FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON change_requests TO console_rt;
GRANT UPDATE (status, decided_by, decision_reason_code, decision_note, decided_at)
    ON change_requests TO console_rt;

COMMENT ON TABLE change_requests IS 'BW-17 change request (변경 요청) to HR; the requester never decides';
COMMENT ON COLUMN change_requests.id IS 'pd:none — change request id';
COMMENT ON COLUMN change_requests.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN change_requests.kind IS 'pd:none — PROFILE_CORRECTION | IDENTITY_REVIEW | ACCESS_REQUEST | SCOPE_ACTION | OTHER';
COMMENT ON COLUMN change_requests.subject_type IS 'pd:none — kind of record the request is about';
COMMENT ON COLUMN change_requests.subject_id IS 'pd:none — logical id of that record (no FK: spans owners)';
COMMENT ON COLUMN change_requests.payload IS 'pd:personal — requested change (PROFILE_CORRECTION: field values such as name or phone)';
COMMENT ON COLUMN change_requests.reason_code IS 'pd:none — BW-07 reason code';
COMMENT ON COLUMN change_requests.note IS 'pd:personal — requester note (free text about the subject)';
COMMENT ON COLUMN change_requests.requested_by IS 'pd:personal — user who filed the request';
COMMENT ON COLUMN change_requests.assignee_role IS 'pd:none — HR: org-wide employee-directory managers';
COMMENT ON COLUMN change_requests.assignee_user_id IS 'pd:personal — named assignee, when one person is asked';
COMMENT ON COLUMN change_requests.status IS 'pd:none — OPEN | APPLIED | DECLINED | WITHDRAWN';
COMMENT ON COLUMN change_requests.decided_by IS 'pd:personal — second person who applied or declined';
COMMENT ON COLUMN change_requests.decision_reason_code IS 'pd:none — BW-07 reason code of the decision';
COMMENT ON COLUMN change_requests.decision_note IS 'pd:personal — decider note (free text about the subject)';
COMMENT ON COLUMN change_requests.created_at IS 'pd:none — request time';
COMMENT ON COLUMN change_requests.decided_at IS 'pd:none — close time (decision or withdrawal)';

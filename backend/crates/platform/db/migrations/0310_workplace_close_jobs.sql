-- UX-R2 ENDS (company-01 / worst-case-18, decisions #21, #28): a 사업장 that
-- still has people or 부서 closes in one act, by a plan with a line for every
-- person (전근 to another open 사업장 of the same 법인 | 퇴직) and for every 부서
-- directly under it (moved under another open 사업장 | 폐지). The job is
-- validated fail-closed when it is planned, applied all-or-none on its
-- 폐쇄일 (inline for today, by the lifecycle tick for a later date), and
-- waits — never half-closes — while a 퇴직 it opened is not yet in effect.
-- Numbered from the lane's range 0330–0331 on console-react-mvp 2742d494
-- (trunk migrations end at 0305); INTEG renumbers.
SET LOCAL lock_timeout = '2s';

CREATE TABLE workplace_close_jobs (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    workplace_id    UUID        NOT NULL,
    legal_entity_id UUID        NOT NULL,
    closed_on       DATE        NOT NULL,
    reason_code     TEXT        NULL
        CONSTRAINT workplace_close_jobs_reason_shape CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z_]{1,39}$'),
    -- SCHEDULED: 폐쇄일 not reached. WAITING: due, but a 퇴직 it opened is not
    -- in effect yet. APPLIED: closed. FAILED: a line was refused on the day
    -- (nothing of that attempt applied). CANCELLED: withdrawn before applying.
    state           TEXT        NOT NULL DEFAULT 'SCHEDULED'
        CONSTRAINT workplace_close_jobs_state_check
        CHECK (state IN ('SCHEDULED', 'WAITING', 'APPLIED', 'FAILED', 'CANCELLED')),
    failure         JSONB       NULL,
    actor_id        UUID        NOT NULL,
    command_id      UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at      TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    CONSTRAINT workplace_close_jobs_command_unique UNIQUE (org_id, command_id),
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
-- One open job per 사업장: a second plan is refused (close_job_open) until
-- the first applies, fails or is cancelled.
CREATE UNIQUE INDEX workplace_close_jobs_open_uniq ON workplace_close_jobs (org_id, workplace_id)
    WHERE state IN ('SCHEDULED', 'WAITING');
-- The tick's due scan.
CREATE INDEX workplace_close_jobs_due_idx ON workplace_close_jobs (org_id, closed_on)
    WHERE state IN ('SCHEDULED', 'WAITING');

ALTER TABLE workplace_close_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_close_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplace_close_jobs
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplace_close_jobs_org_immutable BEFORE UPDATE ON workplace_close_jobs
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
GRANT SELECT, INSERT, UPDATE (state, failure, settled_at) ON workplace_close_jobs TO console_rt;

COMMENT ON TABLE workplace_close_jobs IS 'UX-R2 ENDS: one planned close of a 사업장 with a line for every person and 부서';
COMMENT ON COLUMN workplace_close_jobs.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN workplace_close_jobs.id IS 'pd:none — job id';
COMMENT ON COLUMN workplace_close_jobs.workplace_id IS 'pd:none — the 사업장 that closes';
COMMENT ON COLUMN workplace_close_jobs.legal_entity_id IS 'pd:none — its 법인';
COMMENT ON COLUMN workplace_close_jobs.closed_on IS 'pd:none — 폐쇄일 (the first day it is closed)';
COMMENT ON COLUMN workplace_close_jobs.reason_code IS 'pd:none — why it closes (code)';
COMMENT ON COLUMN workplace_close_jobs.state IS 'pd:none — SCHEDULED | WAITING | APPLIED | FAILED | CANCELLED';
COMMENT ON COLUMN workplace_close_jobs.failure IS 'pd:personal — the refusal of a failed apply: codes and the employee ids it names';
COMMENT ON COLUMN workplace_close_jobs.actor_id IS 'pd:personal — who planned the close';
COMMENT ON COLUMN workplace_close_jobs.command_id IS 'pd:none — the planning request''s Idempotency-Key';
COMMENT ON COLUMN workplace_close_jobs.created_at IS 'pd:none — when it was planned';
COMMENT ON COLUMN workplace_close_jobs.settled_at IS 'pd:none — when it applied, failed or was cancelled';

CREATE TABLE workplace_close_lines (
    org_id            UUID    NOT NULL,
    job_id            UUID    NOT NULL,
    seq               INTEGER NOT NULL CONSTRAINT workplace_close_lines_seq_check CHECK (seq >= 0),
    -- A person line names employee_id; a unit line names org_unit_id.
    employee_id       UUID    NULL,
    org_unit_id       UUID    NULL,
    action            TEXT    NOT NULL
        CONSTRAINT workplace_close_lines_action_check CHECK (action IN ('TRANSFER', 'EXIT', 'MOVE', 'DISSOLVE')),
    -- TRANSFER: the unit the person goes to; MOVE: the unit the 부서 goes under.
    target_unit_id    UUID    NULL,
    -- TRANSFER: the 사업장 that unit is at on the 폐쇄일 (the plan's own moves included).
    target_workplace_id UUID  NULL,
    exit_reason_code  TEXT    NULL
        CONSTRAINT workplace_close_lines_exit_reason_shape CHECK (exit_reason_code IS NULL OR exit_reason_code ~ '^[A-Z][A-Z_]{1,39}$'),
    exit_case_id      UUID    NULL,
    lifecycle_event_id UUID   NULL,
    done              BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (org_id, job_id, seq),
    FOREIGN KEY (org_id, job_id) REFERENCES workplace_close_jobs (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT workplace_close_lines_subject CHECK (
        (action IN ('TRANSFER', 'EXIT') AND employee_id IS NOT NULL AND org_unit_id IS NULL)
        OR (action IN ('MOVE', 'DISSOLVE') AND org_unit_id IS NOT NULL AND employee_id IS NULL)),
    CONSTRAINT workplace_close_lines_target CHECK (
        (action IN ('TRANSFER', 'MOVE')) = (target_unit_id IS NOT NULL)
        AND (action = 'TRANSFER') = (target_workplace_id IS NOT NULL)
        AND (action = 'EXIT') = (exit_reason_code IS NOT NULL))
);
CREATE UNIQUE INDEX workplace_close_lines_person_uniq ON workplace_close_lines (org_id, job_id, employee_id)
    WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX workplace_close_lines_unit_uniq ON workplace_close_lines (org_id, job_id, org_unit_id)
    WHERE org_unit_id IS NOT NULL;

ALTER TABLE workplace_close_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_close_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplace_close_lines
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplace_close_lines_org_immutable BEFORE UPDATE ON workplace_close_lines
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
GRANT SELECT, INSERT, UPDATE (done, lifecycle_event_id) ON workplace_close_lines TO console_rt;

COMMENT ON TABLE workplace_close_lines IS 'UX-R2 ENDS: what a 사업장 close does with one person or one 부서';
COMMENT ON COLUMN workplace_close_lines.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN workplace_close_lines.job_id IS 'pd:none — the close job';
COMMENT ON COLUMN workplace_close_lines.seq IS 'pd:none — line order';
COMMENT ON COLUMN workplace_close_lines.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id';
COMMENT ON COLUMN workplace_close_lines.org_unit_id IS 'pd:none — the 부서 the line moves or dissolves';
COMMENT ON COLUMN workplace_close_lines.action IS 'pd:personal — TRANSFER (전근) | EXIT (퇴직) for a person; MOVE | DISSOLVE for a 부서';
COMMENT ON COLUMN workplace_close_lines.target_unit_id IS 'pd:personal — where the person or 부서 goes';
COMMENT ON COLUMN workplace_close_lines.target_workplace_id IS 'pd:personal — the 사업장 a 전근 lands at';
COMMENT ON COLUMN workplace_close_lines.exit_reason_code IS 'pd:personal — 퇴직 사유 (BW-07 exit_reason: CLOSURE 폐업 | INSOLVENCY 도산)';
COMMENT ON COLUMN workplace_close_lines.exit_case_id IS 'pd:personal — the exit case the 퇴직 opened or joined';
COMMENT ON COLUMN workplace_close_lines.lifecycle_event_id IS 'pd:personal — the 전근 the apply recorded';
COMMENT ON COLUMN workplace_close_lines.done IS 'pd:none — the line has taken effect';

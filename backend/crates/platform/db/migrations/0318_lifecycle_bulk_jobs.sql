-- PERF-BE (decisions #27, #28; capacity report CAP-04): the bulk 발령
-- (`POST /employees/lifecycle-events/bulk`, up to 500 people, all or nothing)
-- as a job when the client sends `Prefer: respond-async`. The request is
-- accepted in one short transaction (this row) and answered 202; a driver
-- runs the batch exactly as the synchronous request does (one transaction,
-- the same Idempotency-Key claim, the same audit rows) and writes its outcome
-- here. Progress steps are audited (`employee.lifecycle.bulk.progress`), the
-- job's realtime topic. Numbered after this lane's 0317 (INTEG renumbered 0308 -> 0318).
--
-- One row per (tenant, Idempotency-Key): the same key and body answer the
-- same job; another body is 409 idempotency_key_reused. A job whose driver
-- died (no heartbeat for longer than the transaction timeout) is finished by
-- the schedule loop: done if its batch committed, else failed
-- `bulk_job_interrupted` (never run twice).
--
-- No seed rows.
SET LOCAL lock_timeout = '2s';

CREATE TABLE employee_lifecycle_bulk_jobs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    idempotency_key     TEXT        NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 200),
    request_fingerprint TEXT        NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    request             JSONB       NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    requested_by        UUID        NOT NULL,
    state               TEXT        NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'done', 'failed')),
    phase               TEXT        NULL CHECK (phase IN ('checking', 'recording')),
    total               INTEGER     NOT NULL DEFAULT 0 CHECK (total >= 0),
    done                INTEGER     NOT NULL DEFAULT 0 CHECK (done >= 0),
    result              JSONB       NULL,
    error               JSONB       NULL,
    heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ NULL,
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (requested_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CHECK ((state IN ('done', 'failed')) = (finished_at IS NOT NULL)),
    CHECK ((state = 'done') = (result IS NOT NULL)),
    CHECK ((state = 'failed') = (error IS NOT NULL))
);
CREATE INDEX employee_lifecycle_bulk_jobs_running_idx
    ON employee_lifecycle_bulk_jobs (org_id, heartbeat_at)
    WHERE state IN ('queued', 'running');

ALTER TABLE employee_lifecycle_bulk_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_lifecycle_bulk_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_lifecycle_bulk_jobs
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL PRIVILEGES ON employee_lifecycle_bulk_jobs FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON employee_lifecycle_bulk_jobs TO console_rt;

COMMENT ON TABLE employee_lifecycle_bulk_jobs IS 'PERF-BE CAP-04: a bulk 발령 accepted as a job (Prefer: respond-async)';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.id IS 'pd:none — job id';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.idempotency_key IS 'pd:none — the request''s Idempotency-Key';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.request_fingerprint IS 'pd:none — SHA-256 of the request body';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.request IS 'pd:personal — the 발령 request: employee ids, destination and the 사유 comment';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.requested_by IS 'pd:personal — user who sent the 발령';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.state IS 'pd:none — queued, running, done or failed';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.phase IS 'pd:none — checking or recording while running';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.total IS 'pd:none — employees in the batch';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.done IS 'pd:none — employees through the current phase';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.result IS 'pd:personal — the batch response (batch id and one event per employee)';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.error IS 'pd:personal — the refusal (code, message, refused employee ids)';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.heartbeat_at IS 'pd:none — last driver step';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.created_at IS 'pd:none — accepted at';
COMMENT ON COLUMN employee_lifecycle_bulk_jobs.finished_at IS 'pd:none — done or failed at';

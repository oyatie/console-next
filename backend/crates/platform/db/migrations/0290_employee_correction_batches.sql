-- MR-27 (decisions #21: every employee field editable through the bulk path
-- too): a bulk 정정 is one job. Numbered head+1 of hard/life/mr27 (the MR-8
-- stack renumbered to 0267-0272 on this branch); INTEG renumbers it with the
-- rest at the batch merge.
--
-- 1. employee_correction_batches: one row per committed bulk correction (the
--    job). Its id is the preview id the person confirmed (derived from the
--    preview digest), so one preview commits at most once. It keeps field
--    NAMES, counts and the digest; the values live only in the ledger rows
--    (employee_corrections), which name the job through batch_id. Append-only.
-- 2. employee_corrections.batch_id: the job a ledger row was written by.
-- 3. api_idempotency_keys: the commit's Idempotency-Key operation.
--    INTEG: other lanes widen this CHECK too (exit, period lock, org change,
--    settings); the trunk migration must carry the union of every list.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. employee_correction_batches
CREATE TABLE employee_correction_batches (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL,
    preview_digest  TEXT        NOT NULL
        CONSTRAINT employee_correction_batches_digest_shape CHECK (preview_digest ~ '^[0-9a-f]{64}$'),
    fields          TEXT[]      NOT NULL
        CONSTRAINT employee_correction_batches_fields_shape CHECK (cardinality(fields) BETWEEN 1 AND 32),
    reason_code     TEXT        NOT NULL
        CONSTRAINT employee_correction_batches_reason_shape CHECK (char_length(reason_code) BETWEEN 1 AND 100),
    selected_count  INTEGER     NOT NULL CHECK (selected_count >= 1),
    change_count    INTEGER     NOT NULL CHECK (change_count >= 0),
    pending_count   INTEGER     NOT NULL CHECK (pending_count >= 0),
    unchanged_count INTEGER     NOT NULL CHECK (unchanged_count >= 0),
    refused_count   INTEGER     NOT NULL CHECK (refused_count >= 0),
    review_required BOOLEAN     NOT NULL,
    created_by      UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employee_correction_batches_counts_add_up CHECK (
        change_count + pending_count + unchanged_count + refused_count = selected_count
        AND change_count + pending_count >= 1
    )
);

ALTER TABLE employee_correction_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_correction_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_correction_batches
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT ON employee_correction_batches TO console_rt;

COMMENT ON TABLE employee_correction_batches IS 'MR-27 one committed bulk 정정 job: field names, counts and the preview digest; values are in employee_corrections';
COMMENT ON COLUMN employee_correction_batches.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN employee_correction_batches.id IS 'pd:none — job id = the confirmed preview id';
COMMENT ON COLUMN employee_correction_batches.preview_digest IS 'pd:none — SHA-256 of the confirmed preview (the step-up payload hash)';
COMMENT ON COLUMN employee_correction_batches.fields IS 'pd:none — names of the corrected fields';
COMMENT ON COLUMN employee_correction_batches.reason_code IS 'pd:none — BW-07 reason code';
COMMENT ON COLUMN employee_correction_batches.selected_count IS 'pd:none — employees the job covered';
COMMENT ON COLUMN employee_correction_batches.change_count IS 'pd:none — employees written at commit';
COMMENT ON COLUMN employee_correction_batches.pending_count IS 'pd:none — employees with a field filed for a second person';
COMMENT ON COLUMN employee_correction_batches.unchanged_count IS 'pd:none — employees already holding the values';
COMMENT ON COLUMN employee_correction_batches.refused_count IS 'pd:none — employees a precondition refused';
COMMENT ON COLUMN employee_correction_batches.review_required IS 'pd:none — a sole holder applied high-risk fields, reviewed after the fact';
COMMENT ON COLUMN employee_correction_batches.created_by IS 'pd:personal — user who committed the job';
COMMENT ON COLUMN employee_correction_batches.created_at IS 'pd:none — commit time';

-- ---------------------------------------------------------------------------
-- 2. employee_corrections.batch_id
ALTER TABLE employee_corrections ADD COLUMN batch_id UUID NULL;
ALTER TABLE employee_corrections ADD CONSTRAINT employee_corrections_batch_fk
    FOREIGN KEY (org_id, batch_id) REFERENCES employee_correction_batches (org_id, id) ON DELETE RESTRICT;
CREATE INDEX employee_corrections_batch_idx ON employee_corrections (org_id, batch_id) WHERE batch_id IS NOT NULL;
COMMENT ON COLUMN employee_corrections.batch_id IS 'pd:none — MR-27 bulk correction job that wrote the row, if any';

-- ---------------------------------------------------------------------------
-- 3. Idempotency-Key operation of the commit
ALTER TABLE api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
        'employee.correction.bulk'
    ));

-- BW-18: employee master-data correction (정정) ledger and identity resolution.
--
-- employee_corrections is append-only: one row per corrected field, written in
-- the transaction that changes the employee, so the old value, the new value,
-- who decided and why are never lost. A correction applied through a BW-17
-- change request points at it; a sole-holder correction is flagged for review.
--
-- employee_identity_resolutions records the verdict on an identity-review
-- record. SAME is a merge: merged_into_employee_id is the merge pointer to the
-- record that is kept. It lives here, not as an employees column, because the
-- employees / employee_employment_profiles migrations belong to EMP-MODEL
-- (delivery-plan §4.1). At most one merge pointer per employee.
--
-- No seed rows. Numbered head+1 of the lane base; INTEG renumbers it at the
-- batch merge (tools/integ/renumber-migrations.sh).
SET LOCAL lock_timeout = '2s';

CREATE TABLE employee_corrections (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id          UUID        NOT NULL,
    field                TEXT        NOT NULL CHECK (field IN (
                             'name', 'phone', 'hire_date', 'employment_type', 'position_id', 'base_pay'
                         )),
    old_value            JSONB       NULL,
    new_value            JSONB       NOT NULL,
    reason_code          TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    note                 TEXT        NULL
                             CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)),
    corrected_by         UUID        NOT NULL,
    change_request_id    UUID        NULL,
    review_required      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (employee_id, org_id)       REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (corrected_by, org_id)      REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (change_request_id, org_id) REFERENCES change_requests(id, org_id) ON DELETE RESTRICT
);

CREATE INDEX employee_corrections_org_employee_idx
    ON employee_corrections (org_id, employee_id, created_at);

CREATE TABLE employee_identity_resolutions (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id            UUID        NOT NULL,
    verdict                TEXT        NOT NULL CHECK (verdict IN ('SAME', 'DIFFERENT')),
    merged_into_employee_id UUID       NULL,
    reason_code            TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    resolved_by            UUID        NOT NULL,
    change_request_id      UUID        NULL,
    step_up_assertion_id   UUID        NULL,
    review_required        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (employee_id, org_id)             REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (merged_into_employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (resolved_by, org_id)             REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (change_request_id, org_id)       REFERENCES change_requests(id, org_id) ON DELETE RESTRICT,
    -- A merge names the kept record; DIFFERENT names none. Never itself.
    CONSTRAINT employee_identity_resolutions_merge_shape CHECK (
        (verdict = 'SAME') = (merged_into_employee_id IS NOT NULL)
        AND (merged_into_employee_id IS NULL OR merged_into_employee_id <> employee_id)
    ),
    -- A merge is always step-up verified (IDENTITY_MERGE).
    CONSTRAINT employee_identity_resolutions_merge_step_up CHECK (
        verdict <> 'SAME' OR step_up_assertion_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX employee_identity_resolutions_one_merge_idx
    ON employee_identity_resolutions (org_id, employee_id)
    WHERE merged_into_employee_id IS NOT NULL;
CREATE INDEX employee_identity_resolutions_org_employee_idx
    ON employee_identity_resolutions (org_id, employee_id, created_at);

ALTER TABLE employee_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_corrections
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_corrections_org_immutable BEFORE UPDATE ON employee_corrections
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_identity_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_identity_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_identity_resolutions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_identity_resolutions_org_immutable BEFORE UPDATE ON employee_identity_resolutions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- Append-only evidence: no UPDATE, no DELETE for the serving role.
REVOKE ALL PRIVILEGES ON employee_corrections, employee_identity_resolutions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON employee_corrections, employee_identity_resolutions TO console_rt;

COMMENT ON TABLE employee_corrections IS 'BW-18 append-only ledger of employee master-data corrections (정정), one row per field';
COMMENT ON COLUMN employee_corrections.id IS 'pd:none — correction id';
COMMENT ON COLUMN employee_corrections.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_corrections.employee_id IS 'pd:personal — corrected employee; row is a natural person';
COMMENT ON COLUMN employee_corrections.field IS 'pd:none — corrected field name';
COMMENT ON COLUMN employee_corrections.old_value IS 'pd:personal — value before the correction (e.g. name, hire date)';
COMMENT ON COLUMN employee_corrections.new_value IS 'pd:personal — value after the correction';
COMMENT ON COLUMN employee_corrections.reason_code IS 'pd:none — BW-07 reason code';
COMMENT ON COLUMN employee_corrections.note IS 'pd:personal — corrector note (free text about the subject)';
COMMENT ON COLUMN employee_corrections.corrected_by IS 'pd:personal — user who applied the correction';
COMMENT ON COLUMN employee_corrections.change_request_id IS 'pd:none — BW-17 request it was applied through, if any';
COMMENT ON COLUMN employee_corrections.review_required IS 'pd:none — sole-holder correction, reviewed after the fact';
COMMENT ON COLUMN employee_corrections.created_at IS 'pd:none — correction time';

COMMENT ON TABLE employee_identity_resolutions IS 'BW-18 identity-review verdicts; SAME carries the merge pointer';
COMMENT ON COLUMN employee_identity_resolutions.id IS 'pd:none — resolution id';
COMMENT ON COLUMN employee_identity_resolutions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_identity_resolutions.employee_id IS 'pd:personal — reviewed employee record; row is a natural person';
COMMENT ON COLUMN employee_identity_resolutions.verdict IS 'pd:none — SAME (merge) or DIFFERENT';
COMMENT ON COLUMN employee_identity_resolutions.merged_into_employee_id IS 'pd:personal — kept employee record of a SAME merge';
COMMENT ON COLUMN employee_identity_resolutions.reason_code IS 'pd:none — BW-07 reason code';
COMMENT ON COLUMN employee_identity_resolutions.resolved_by IS 'pd:personal — user who resolved (the second person when one exists)';
COMMENT ON COLUMN employee_identity_resolutions.change_request_id IS 'pd:none — BW-17 IDENTITY_REVIEW request it was applied through, if any';
COMMENT ON COLUMN employee_identity_resolutions.step_up_assertion_id IS 'pd:none — BW-29 IDENTITY_MERGE step-up (step_up_assertions.ceremony_id)';
COMMENT ON COLUMN employee_identity_resolutions.review_required IS 'pd:none — sole-holder merge, reviewed after the fact';
COMMENT ON COLUMN employee_identity_resolutions.created_at IS 'pd:none — resolution time';

-- BW-13: the job-title catalog and the required leave facts.
-- Numbered head+1 of hard/life/bw13 (R2-life + the EMP-MODEL migration 0256);
-- INTEG renumbers at the batch merge. Frozen on commit: PEOPLE rebases onto it
-- before BW-18.
--
-- 1. job_titles: one tenant catalog of 직위/직책, ordered by grade_rank
--    (prototype-parity D4: one catalog instead of three hard-coded lists).
--    No seed rows: a tenant adds its own titles. Titles are deactivated, never
--    deleted, so history keeps resolving. A label is unique per tenant
--    regardless of case, which also makes "add" idempotent (the writer returns
--    the existing row on a repeat).
-- 2. employees.job_title_id (G7: named job_title_id, not position_id). The
--    free-text employees.position stays for display and import; a PROMOTE by
--    catalog id projects the label into it.
-- 3. employee_lifecycle_events.{from,to}_job_title_id: the PROMOTE pair, so
--    the 강등 check and a later rescind (BW-11) read ids, not labels.
-- 4. Leave facts for NEW rows only, as a BEFORE INSERT trigger rather than a
--    NOT VALID CHECK: a NOT VALID CHECK is still enforced on UPDATE, and the
--    0246 trigger lets a SCHEDULED row move to APPLIED/CANCELLED, so an older
--    scheduled leave without a type would fail on its apply date.
--      * LEAVE_OF_ABSENCE needs leave_type.
--      * CHILDCARE (남녀고용평등법 §19) and MATERNITY (근로기준법 §74) need
--        expected_return_date.
-- Deliberately NOT here:
--   * WORK_INJURY as a built-in leave type (G8: 노무사 confirms the §23② guard
--     first); a later migration grows the leave_type CHECK like 0245 did.
--   * Tenant-added leave types: they need a leave_type domain in the settings
--     code lists (GOV-RC) before the CHECK can admit T_ codes.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. job_titles
CREATE TABLE job_titles (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    label       TEXT        NOT NULL
        CONSTRAINT job_titles_label_shape CHECK (btrim(label) = label AND char_length(label) BETWEEN 1 AND 100),
    -- Higher = more senior. NULL = unranked (no demotion verdict either way).
    grade_rank  INTEGER     NULL
        CONSTRAINT job_titles_grade_rank_range CHECK (grade_rank BETWEEN 0 AND 1000),
    active      BOOLEAN     NOT NULL DEFAULT true,
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX job_titles_org_label_key ON job_titles (org_id, lower(label));

ALTER TABLE job_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_titles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON job_titles
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_job_titles_org_immutable BEFORE UPDATE ON job_titles
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

GRANT SELECT, INSERT ON job_titles TO console_rt;
GRANT UPDATE (label, grade_rank, active) ON job_titles TO console_rt;

COMMENT ON TABLE job_titles IS 'BW-13 직위·직책 catalog per tenant, ordered by grade_rank; deactivated, never deleted';
COMMENT ON COLUMN job_titles.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN job_titles.id IS 'pd:none — catalog entry id';
COMMENT ON COLUMN job_titles.label IS 'pd:none — title label (직위·직책), unique per tenant ignoring case';
COMMENT ON COLUMN job_titles.grade_rank IS 'pd:none — seniority, higher = more senior; a PROMOTE to a lower rank needs reason code DISCIPLINARY_DEMOTION (강등(징계)); NULL = unranked';
COMMENT ON COLUMN job_titles.active IS 'pd:none — false hides the title from new assignments; history keeps resolving';
COMMENT ON COLUMN job_titles.created_by IS 'pd:personal — user who added the title';
COMMENT ON COLUMN job_titles.created_at IS 'pd:none — when the title was added';

-- ---------------------------------------------------------------------------
-- 2. employees.job_title_id
ALTER TABLE employees
    ADD COLUMN job_title_id UUID NULL;
ALTER TABLE employees ADD CONSTRAINT employees_job_title_fk
    FOREIGN KEY (org_id, job_title_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;
CREATE INDEX employees_org_job_title_idx ON employees (org_id, job_title_id)
    WHERE job_title_id IS NOT NULL;

COMMENT ON COLUMN employees.job_title_id IS 'pd:personal — current 직위·직책 (catalog id); position keeps the display text; 개보법 제2조제1호나목 결합 식별';

-- ---------------------------------------------------------------------------
-- 3. employee_lifecycle_events: the PROMOTE title pair
ALTER TABLE employee_lifecycle_events
    ADD COLUMN from_job_title_id UUID NULL,
    ADD COLUMN to_job_title_id UUID NULL;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_from_job_title_fk
    FOREIGN KEY (org_id, from_job_title_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_to_job_title_fk
    FOREIGN KEY (org_id, to_job_title_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_to_job_title_event_check
    CHECK (to_job_title_id IS NULL OR event_type = 'PROMOTE');

COMMENT ON COLUMN employee_lifecycle_events.from_job_title_id IS 'pd:personal — 직위·직책 before a PROMOTE (catalog id); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_job_title_id IS 'pd:personal — 직위·직책 after a PROMOTE (catalog id); 개보법 제2조제1호나목 결합 식별';

-- ---------------------------------------------------------------------------
-- 4. Leave facts on new rows
CREATE FUNCTION employee_lifecycle_events_leave_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.leave_type IS NULL THEN
        RAISE EXCEPTION 'leave_type is required for LEAVE_OF_ABSENCE'
            USING ERRCODE = '23514', CONSTRAINT = 'employee_lifecycle_events_leave_type_required';
    END IF;
    IF NEW.leave_type IN ('CHILDCARE', 'MATERNITY') AND NEW.expected_return_date IS NULL THEN
        RAISE EXCEPTION 'expected_return_date is required for % leave', NEW.leave_type
            USING ERRCODE = '23514', CONSTRAINT = 'employee_lifecycle_events_return_date_required';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_employee_lifecycle_events_leave_facts
    BEFORE INSERT ON employee_lifecycle_events
    FOR EACH ROW WHEN (NEW.event_type = 'LEAVE_OF_ABSENCE')
    EXECUTE FUNCTION employee_lifecycle_events_leave_facts();

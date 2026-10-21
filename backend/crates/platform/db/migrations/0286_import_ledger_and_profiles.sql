-- IMPORT lane, MR-7: an import is a safe bulk create and update.
-- Numbered head+1 of the lane base (0274, the IMPORT port); INTEG renumbers
-- at the batch merge (tools/integ/renumber-migrations.sh).
--
-- 1. employee_corrections (the BW-18 ledger) also records what an import
--    changed on a person already on file, one row per field, so a bulk change
--    keeps the old value, the new value, who and which run, exactly like a
--    정정. The columns an import may write join the correctable fields, and
--    import_run_id names the run (reason_code IMPORT_APPLY). The unique index
--    makes a replayed settle write each change once. PEOPLE-A's MR-8 widens
--    the same field CHECK: INTEG keeps the union of the two lists.
-- 2. employee_employment_profiles: phone_e164 and base_pay become optional.
--    The register form and the import both accept a person without a known
--    phone or pay (onboarding design §4.1: 휴대폰 not required, 기본급
--    optional; a migrated 명부 rarely carries either), and the import creates
--    the profile from the 고용형태 alone. employment_type stays required: a
--    row without it gets no profile (정보 미입력) until a later file or a
--    정정 supplies it.
-- No seed rows.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_corrections DROP CONSTRAINT employee_corrections_field_check;
ALTER TABLE employee_corrections ADD CONSTRAINT employee_corrections_field_check
    CHECK (field IN (
        'name', 'phone', 'job', 'work_email', 'id_type',
        'hire_date', 'exit_date', 'birth_date', 'employee_number',
        'employment_type', 'base_pay', 'pay_unit', 'probation_end_date',
        'position_id',
        -- IMPORT (MR-7) ledger rows; INTEG keeps the union with MR-8's 0288.
        'position', 'worksite_name', 'worksite_address'
    ));
ALTER TABLE employee_corrections
    ADD COLUMN import_run_id UUID NULL,
    ADD CONSTRAINT employee_corrections_import_run_fk
        FOREIGN KEY (import_run_id, org_id) REFERENCES data_import_runs (id, org_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX employee_corrections_import_once_idx
    ON employee_corrections (org_id, import_run_id, employee_id, field)
    WHERE import_run_id IS NOT NULL;
COMMENT ON COLUMN employee_corrections.import_run_id IS 'pd:none — MR-7 import run that applied this change, if any';

ALTER TABLE employee_employment_profiles
    ALTER COLUMN phone_e164 DROP NOT NULL,
    ALTER COLUMN base_pay DROP NOT NULL;

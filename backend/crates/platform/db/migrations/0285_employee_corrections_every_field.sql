-- MR-8 (PEOPLE-A): one 정정 path for every scalar employee field. The BW-18
-- ledger widens from its six fields to every field the PATCH, an applied
-- PROFILE_CORRECTION and the EMP-MODEL facts PATCH write (근로기준법 §41②:
-- a changed register item is corrected without delay, so each correction
-- keeps its old value, new value, who and why).
--
-- The text twins of the placement (company, worksite_name, worksite_address,
-- org_unit) are not here: the 법인, 사업장 and 부서 change through the
-- employment assignment, never as a text correction.
--
-- Numbered head+1 of this lane's stack (BW-18 0258/0259, emp-create renumbered
-- 0260/0261); INTEG renumbers it at the batch merge
-- (tools/integ/renumber-migrations.sh). No seed rows. The ledger stays
-- append-only (0258 grants SELECT, INSERT only).
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_corrections DROP CONSTRAINT employee_corrections_field_check;
ALTER TABLE employee_corrections ADD CONSTRAINT employee_corrections_field_check CHECK (field IN (
    'name', 'phone', 'job', 'work_email', 'id_type',
    'hire_date', 'exit_date', 'birth_date', 'employee_number',
    'employment_type', 'base_pay', 'pay_unit', 'probation_end_date',
    'position_id'
));

-- The 0258 classification stands (old_value / new_value pd:personal). Since
-- MR-8 a NULL old_value is a first recording and a JSON null new_value a
-- cleared field; the column comments stay in 0258 (one marker per column).

-- CX-grade-fix: catalog-valued corrections keep the same append-only before/after ledger.
-- Expand only: existing correction fields and readers remain valid.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_corrections DROP CONSTRAINT employee_corrections_field_check;
ALTER TABLE employee_corrections ADD CONSTRAINT employee_corrections_field_check CHECK (field IN (
    'name', 'phone', 'job', 'work_email', 'id_type',
    'hire_date', 'exit_date', 'birth_date', 'employee_number',
    'employment_type', 'base_pay', 'pay_unit', 'probation_end_date',
    'position_id', 'position', 'worksite_name', 'worksite_address',
    'sex', 'address', 'careers', 'exit_reason', 'register_note',
    'name_hanja', 'name_en', 'nationality', 'personal_email',
    'emergency_contacts', 'photo', 'group_service_start_date',
    'grade_id', 'job_title_id', 'position_kind_id', 'job_id', 'job_family_id'
));

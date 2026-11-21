-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Widen employee_corrections_field_check to allow bank_account_registered while retaining all prior fields.
-- contract-of: 20261121120100000
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_corrections
    DROP CONSTRAINT employee_corrections_field_check,
    ADD CONSTRAINT employee_corrections_field_check CHECK (field IN (
        'name', 'phone', 'job', 'work_email', 'id_type',
        'hire_date', 'exit_date', 'birth_date', 'employee_number',
        'employment_type', 'base_pay', 'pay_unit', 'probation_end_date',
        'position_id', 'position', 'worksite_name', 'worksite_address',
        'sex', 'address', 'careers', 'exit_reason', 'register_note',
        'name_hanja', 'name_en', 'nationality', 'personal_email',
        'emergency_contacts', 'photo', 'group_service_start_date',
        'grade_id', 'job_title_id', 'position_kind_id', 'job_id', 'job_family_id',
        'bank_account_registered'
    )) NOT VALID;

ALTER TABLE employee_corrections
    VALIDATE CONSTRAINT employee_corrections_field_check;

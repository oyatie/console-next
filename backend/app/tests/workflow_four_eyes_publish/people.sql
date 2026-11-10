-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Linking the employee invokes the canonical Person-binding trigger.
WITH employee AS (
    INSERT INTO employees
      (org_id, company, name, source_filename, source_sheet, source_row,
       source_key, identity_review_required)
    VALUES ($4, 'ACME', $2, 'seed.xlsx', 'Sheet1', 1, $1::uuid::text, false)
    RETURNING id
)
INSERT INTO users (id, display_name, roles, org_id, employee_id)
SELECT $1, $2, $3, $4, employee.id FROM employee;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Set-based canonical person facts for tenant-wide assessment.
-- Keep the indexed current-person view for bounded hydration.
CREATE VIEW person_employees_current_set WITH (security_invoker=true) AS
SELECT e.id,e.org_id,e.employee_number,e.home_branch_id,e.org_unit_id,e.voided_at,
    coalesce(f.attributes->>'legal_name',e.name) AS name,
    CASE WHEN f.attributes ? 'birth_date' THEN (f.attributes->>'birth_date')::DATE
        ELSE e.birth_date END AS birth_date
FROM employees e
LEFT JOIN employee_person_bindings b ON b.org_id=e.org_id AND b.employee_id=e.id
LEFT JOIN (
    SELECT DISTINCT ON (org_id,person_id) org_id,person_id,attributes
    FROM person_revisions ORDER BY org_id,person_id,version DESC
) f ON f.org_id=b.org_id AND f.person_id=b.person_id;
GRANT SELECT ON person_employees_current_set TO console_rt;

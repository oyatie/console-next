-- no-transaction
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce partial uniqueness of PRE_HIRE NOT_ISSUED rows on normalized name and birth date
CREATE UNIQUE INDEX CONCURRENTLY employees_prehire_not_issued_identity_idx
    ON employees (org_id, lower(regexp_replace(name, '\s', '', 'g')), birth_date)
    WHERE (
        employment_status = 'PRE_HIRE'
        AND id_type = 'NOT_ISSUED'
        AND birth_date IS NOT NULL
        AND merged_into_employee_id IS NULL
    );

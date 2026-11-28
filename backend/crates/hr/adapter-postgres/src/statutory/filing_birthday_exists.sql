-- SPDX-License-Identifier: LicenseRef-Proprietary
WITH clock AS MATERIALIZED (
    SELECT max(EXTRACT(year FROM (COALESCE($2, now()) AT TIME ZONE z.time_zone))) AS year
    FROM (SELECT time_zone FROM lifecycle_country_packs WHERE is_default
          UNION SELECT time_zone FROM workplaces WHERE org_id = $1
          UNION SELECT time_zone FROM legal_entities WHERE org_id = $1) z
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND birth_date IS NOT NULL)
            OR EXISTS (SELECT 1 FROM person_revisions WHERE org_id = $1 AND attributes->>'birth_date' IS NOT NULL)
    -- A canonical birthday can only originate in one of these two stores. If either has
    -- dates, resolve the current binding and revision before deciding to load AGE60 work.
    THEN EXISTS (SELECT 1 FROM person_employees_current x CROSS JOIN clock
                 WHERE x.org_id = $1 AND EXTRACT(year FROM x.birth_date) + $3 <= clock.year)
    ELSE false
END OR EXISTS (
    SELECT 1 FROM insurance_filing_records r CROSS JOIN clock
    WHERE r.org_id = $1 AND EXTRACT(year FROM (r.applicability_facts->>'birth_date')::date) + $3 <= clock.year
)

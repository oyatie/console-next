-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Keep the current-person projection and look up one binding per employee.
-- The binding's primary key is (org_id, employee_id). An explicit bound keeps a freshly imported
-- tenant from scanning all its bindings for every employee while PostgreSQL is collecting statistics.
DO $$
DECLARE
    cols text;
BEGIN
    -- Preserve this view's released columns and their order, including when the base table has grown.
    SELECT string_agg(CASE a.attname
        WHEN 'name' THEN 'coalesce(f.attributes->>''legal_name'',e.name) AS name'
        WHEN 'birth_date' THEN 'CASE WHEN f.attributes ? ''birth_date'' THEN (f.attributes->>''birth_date'')::date ELSE e.birth_date END AS birth_date'
        ELSE 'e.' || quote_ident(a.attname) END, ',' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
    WHERE a.attrelid = 'public.person_employees_current'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

    EXECUTE 'CREATE OR REPLACE VIEW public.person_employees_current WITH (security_invoker=true) AS SELECT ' || cols ||
        ' FROM public.employees e
          LEFT JOIN LATERAL (
              SELECT binding.person_id FROM public.employee_person_bindings binding
              WHERE binding.org_id = e.org_id AND binding.employee_id = e.id LIMIT 1
          ) b ON true
          LEFT JOIN LATERAL (
              SELECT r.attributes FROM public.person_revisions r
              WHERE r.org_id = e.org_id AND r.person_id = b.person_id ORDER BY r.version DESC LIMIT 1
          ) f ON true';
END $$;

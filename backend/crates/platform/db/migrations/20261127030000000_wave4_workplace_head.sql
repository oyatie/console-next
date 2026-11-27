-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Add workplace head columns and supervised-workplace helper for go-live readiness.
-- contract-of: 0298
-- console-gate: audited-table workplaces
SET LOCAL lock_timeout = '2s';

ALTER TABLE workplaces
    ADD COLUMN IF NOT EXISTS head_employee_id UUID NULL,
    ADD COLUMN IF NOT EXISTS head_since DATE NULL;

ALTER TABLE workplaces
    DROP CONSTRAINT IF EXISTS workplaces_head_employee_fk,
    ADD CONSTRAINT workplaces_head_employee_fk
        FOREIGN KEY (head_employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE workplaces
    VALIDATE CONSTRAINT workplaces_head_employee_fk;

GRANT UPDATE (head_employee_id, head_since) ON workplaces TO console_rt;

COMMENT ON COLUMN workplaces.head_employee_id IS 'pd:personal — employee appointed as workplace head; NULL when vacant';
COMMENT ON COLUMN workplaces.head_since IS 'pd:none — KST calendar date the current workplace head was appointed';

INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id)
VALUES ('workplace', 'workplace.head', 'workplace', true)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION supervised_without_department_employee_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT a.employee_id
    FROM employment_resolved_assignments a
    JOIN workplaces w ON w.id = a.workplace_id AND w.org_id = a.org_id
    JOIN employees h ON h.id = w.head_employee_id AND h.org_id = w.org_id
    JOIN employees emp ON emp.id = a.employee_id AND emp.org_id = a.org_id
    WHERE w.voided_at IS NULL
      AND w.closed_on IS NULL
      AND entity_employment_status_on(entity_today(), h.hire_on, h.exit_on, h.employment_status) NOT IN ('EXITED', 'VOIDED')
      AND (
          emp.org_unit_id IS NULL
          OR EXISTS (
              SELECT 1
              FROM org_unit_placements p
              WHERE p.org_unit_id = emp.org_unit_id
                AND p.workplace_id = w.id
                AND p.represents_workplace
                AND p.valid_to IS NULL
          )
      );
$$;

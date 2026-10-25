-- SPDX-License-Identifier: LicenseRef-Proprietary
SET LOCAL lock_timeout = '2s';

-- SQL-language date helpers must resolve their callees under pinned definer search paths too.
CREATE OR REPLACE FUNCTION entity_employed_on(on_date DATE, hire_date DATE, last_working_day DATE, status TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT COALESCE(on_date IS NOT NULL AND status <> 'VOIDED'
        AND (hire_date IS NULL OR hire_date <= on_date)
        AND (last_working_day IS NULL OR on_date < public.entity_retirement_on(last_working_day))
        AND (status <> 'EXITED' OR last_working_day IS NOT NULL)
        AND (status <> 'PRE_HIRE' OR hire_date IS NOT NULL), false)
$$;
CREATE OR REPLACE FUNCTION entity_employment_status_on(on_date DATE, hire_date DATE, last_working_day DATE, status TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN status = 'VOIDED' THEN status WHEN hire_date > on_date THEN 'PRE_HIRE'
        WHEN public.entity_employed_on(on_date, hire_date, last_working_day, status)
            THEN CASE WHEN status IN ('PRE_HIRE', 'EXITED') THEN 'ACTIVE' ELSE status END
        WHEN last_working_day < on_date THEN 'EXITED' ELSE status END
$$;

-- One as-of assignment: today's interval, an exited person's last, or a pre-hire's first.
CREATE VIEW employment_resolved_assignments WITH (security_invoker = true) AS
SELECT DISTINCT ON (a.org_id, a.employee_id)
    a.org_id, a.id, a.employee_id, a.legal_entity_id, a.workplace_id, a.actor_id, a.command_id,
    a.valid_from, a.valid_to,
    entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS employment_status
FROM employment_assignments a
JOIN employees e ON e.org_id = a.org_id AND e.id = a.employee_id
WHERE a.superseded_at IS NULL AND (
    (a.valid_from <= entity_today() AND (a.valid_to IS NULL OR a.valid_to > entity_today()))
    OR (entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) = 'EXITED'
        AND a.valid_from <= entity_today())
    OR (entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) = 'PRE_HIRE'
        AND a.valid_from > entity_today()))
ORDER BY a.org_id, a.employee_id, a.valid_from <= entity_today() DESC,
    CASE WHEN a.valid_from <= entity_today() THEN a.valid_from END DESC, a.valid_from;
CREATE VIEW employment_current_placements WITH (security_invoker = true) AS
SELECT org_id, id, employee_id, legal_entity_id, workplace_id, actor_id, command_id, valid_from, valid_to
FROM employment_resolved_assignments
WHERE workplace_id IS NOT NULL AND employment_status <> 'EXITED';
-- The setup rail and the remedy queue must count exactly the same people.
CREATE VIEW employment_unplaced_people WITH (security_invoker = true) AS
SELECT e.org_id, e.id AS employee_id
FROM person_employees_current e
LEFT JOIN employment_current_placements cp ON cp.org_id=e.org_id AND cp.employee_id=e.id
WHERE entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) NOT IN ('EXITED', 'VOIDED')
    AND e.merged_into_employee_id IS NULL AND cp.employee_id IS NULL;
GRANT SELECT ON employment_unplaced_people TO console_rt;
GRANT SELECT ON employment_resolved_assignments, employment_current_placements TO console_rt, console_leave_definer;
GRANT SELECT (hire_on, exit_on, employment_status) ON employees TO console_leave_definer;
GRANT EXECUTE ON FUNCTION entity_employment_status_on(DATE, DATE, DATE, TEXT),
    entity_employed_on(DATE, DATE, DATE, TEXT), entity_retirement_on(DATE) TO console_leave_definer;

CREATE SCHEMA hr_api AUTHORIZATION console_leave_definer;
REVOKE ALL ON SCHEMA hr_api FROM PUBLIC;
GRANT USAGE ON SCHEMA hr_api TO console_rt;
GRANT SELECT (id, legal_entity_id, actor_id, command_id) ON employment_assignments TO console_leave_definer;
GRANT EXECUTE ON FUNCTION entity_today() TO console_leave_definer;

-- The insert trigger and due runner both repair the same derived routing copy.
CREATE OR REPLACE FUNCTION hr_api.route_placement_home_branch(p_org UUID, p_employee UUID) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on AS $$
DECLARE
    v_branch UUID;
    v_old UUID;
    v_assignment UUID;
    v_actor UUID;
    v_command UUID;
BEGIN
    IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::UUID THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'leave_home_branch.tenant_mismatch';
    END IF;
    -- Import settle owns this write and its inverse, including released binaries without a marker.
    IF NULLIF(current_setting('app.employee_import_run', true), '') IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.import_run_row_snapshots s
        JOIN public.data_import_runs r ON r.org_id=s.org_id AND r.id=s.run_id
        WHERE s.org_id=p_org AND s.employee_id=p_employee AND s.outcome='INSERTED'
          AND r.status='APPLIED' AND r.apply_job->>'state' IN ('applying','settling')
          AND NOT EXISTS (SELECT 1 FROM public.import_run_effects f
              WHERE f.org_id=s.org_id AND f.run_id=s.run_id AND f.employee_id=s.employee_id
                AND f.effect='head_settled')
    ) THEN RETURN NULL; END IF;
    SELECT e.home_branch_id INTO v_old FROM public.employees e
     WHERE e.org_id = p_org AND e.id = p_employee
       AND e.employment_status NOT IN ('EXITED', 'VOIDED') FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT w.default_branch_id, a.id, a.actor_id, a.command_id
      INTO v_branch, v_assignment, v_actor, v_command
      FROM public.employment_current_placements a
      JOIN public.workplaces w ON w.org_id = a.org_id AND w.id = a.workplace_id
      JOIN public.branches b ON b.org_id = w.org_id AND b.id = w.default_branch_id
     WHERE a.org_id = p_org AND a.employee_id = p_employee AND b.deactivated_at IS NULL
       AND a.valid_from <= public.entity_today() AND (a.valid_to IS NULL OR a.valid_to > public.entity_today());
    IF v_branch IS NULL OR v_old IS NOT DISTINCT FROM v_branch THEN RETURN NULL; END IF;
    UPDATE public.employees SET home_branch_id = v_branch, updated_at = now()
     WHERE org_id = p_org AND id = p_employee;
    INSERT INTO public.audit_events
        (actor, action, target_type, target_id, branch_id, before_snap, after_snap,
         trace_id, span_id, occurred_at, org_id)
    VALUES (v_actor, 'employee.home_branch_set', 'employee', p_employee::text, v_branch,
        jsonb_build_object('home_branch_id', v_old),
        jsonb_build_object('home_branch_id', v_branch, 'assignment_id', v_assignment, 'command_id', v_command),
        replace(gen_random_uuid()::text, '-', ''), left(replace(gen_random_uuid()::text, '-', ''), 16),
        now(), p_org);
    RETURN v_branch;
END $$;
ALTER FUNCTION hr_api.route_placement_home_branch(UUID, UUID) OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION hr_api.route_placement_home_branch(UUID, UUID) FROM PUBLIC, console_leave_cmd;
GRANT EXECUTE ON FUNCTION hr_api.route_placement_home_branch(UUID, UUID) TO console_rt;

CREATE OR REPLACE FUNCTION leave_api.follow_assignment_branch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on AS $$
DECLARE v_org UUID := NULLIF(current_setting('app.current_org', true), '')::UUID;
BEGIN
    IF v_org IS NULL THEN RETURN NEW; END IF;
    IF NEW.org_id IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'leave_home_branch.tenant_mismatch';
    END IF;
    PERFORM hr_api.route_placement_home_branch(NEW.org_id, NEW.employee_id);
    RETURN NEW;
END $$;
ALTER FUNCTION leave_api.follow_assignment_branch() OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION leave_api.follow_assignment_branch() FROM PUBLIC, console_rt, console_leave_cmd;

-- Migration-only, tenant-scoped repair; runtime roles cannot invoke it.
CREATE OR REPLACE FUNCTION hr_api.backfill_placement_home_branch() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on AS $$
DECLARE
    v_count bigint;
    v_org UUID := NULLIF(current_setting('app.current_org', true), '')::UUID;
BEGIN
    IF v_org IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'leave_home_branch.tenant_required';
    END IF;
    WITH changed AS (
        UPDATE public.employees e SET home_branch_id = w.default_branch_id, updated_at = now()
          FROM public.employment_current_placements a
          JOIN public.workplaces w ON w.org_id = a.org_id AND w.id = a.workplace_id
          JOIN public.branches b ON b.org_id = w.org_id AND b.id = w.default_branch_id
         WHERE e.org_id = v_org AND a.org_id = e.org_id AND a.employee_id = e.id
           AND b.deactivated_at IS NULL AND e.home_branch_id IS NULL
           AND a.valid_from <= public.entity_today() AND (a.valid_to IS NULL OR a.valid_to > public.entity_today())
           AND e.employment_status NOT IN ('EXITED', 'VOIDED')
        RETURNING e.id, e.home_branch_id
    ), audited AS (
        INSERT INTO public.audit_events
            (actor, action, target_type, target_id, branch_id, before_snap, after_snap,
             trace_id, span_id, occurred_at, org_id)
        SELECT NULL, 'employee.home_branch_set', 'employee', c.id::text, c.home_branch_id,
            jsonb_build_object('home_branch_id', NULL),
            jsonb_build_object('home_branch_id', c.home_branch_id, 'reason', 'placement_backfill'),
            replace(gen_random_uuid()::text, '-', ''), left(replace(gen_random_uuid()::text, '-', ''), 16), now(), v_org
        FROM changed c RETURNING 1
    ) SELECT count(*) INTO v_count FROM audited;
    RETURN v_count;
END $$;
ALTER FUNCTION hr_api.backfill_placement_home_branch() OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION hr_api.backfill_placement_home_branch() FROM PUBLIC, console_rt, console_leave_cmd;

DO $$
DECLARE
    v_org UUID;
    v_total bigint := 0;
    v_previous_org TEXT := current_setting('app.current_org', true);
BEGIN
    FOR v_org IN SELECT id FROM organizations LOOP
        PERFORM set_config('app.current_org', v_org::text, true);
        v_total := v_total + hr_api.backfill_placement_home_branch();
    END LOOP;
    PERFORM set_config('app.current_org', coalesce(v_previous_org, ''), true);
    RAISE NOTICE 'placement_home_branch_backfill repaired=%', v_total;
END $$;

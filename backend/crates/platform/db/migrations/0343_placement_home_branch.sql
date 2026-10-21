-- Routing follows the live assignment, including a correction or a rescinded move.
-- Keep the existing create command responsible for establishing first routing.
SET LOCAL lock_timeout = '2s';
GRANT SELECT ON employment_assignments, workplaces TO console_leave_definer;

CREATE FUNCTION leave_api.follow_assignment_branch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
    v_branch UUID;
    v_old UUID;
BEGIN
    IF NEW.superseded_at IS NOT NULL
       OR NEW.valid_from > (now() AT TIME ZONE 'Asia/Seoul')::date
       OR NEW.valid_to <= (now() AT TIME ZONE 'Asia/Seoul')::date THEN
        RETURN NEW;
    END IF;
    SELECT w.default_branch_id INTO v_branch FROM public.workplaces w
      JOIN public.branches b ON b.org_id = w.org_id AND b.id = w.default_branch_id
     WHERE w.org_id = NEW.org_id AND w.id = NEW.workplace_id AND b.deactivated_at IS NULL;
    IF v_branch IS NULL THEN RETURN NEW; END IF;
    SELECT e.home_branch_id INTO v_old FROM public.employees e
     WHERE e.org_id = NEW.org_id AND e.id = NEW.employee_id FOR UPDATE;
    IF v_old IS NULL OR v_old = v_branch THEN RETURN NEW; END IF;
    UPDATE public.employees SET home_branch_id = v_branch, updated_at = now()
     WHERE org_id = NEW.org_id AND id = NEW.employee_id;
    INSERT INTO public.audit_events
        (actor, action, target_type, target_id, branch_id, before_snap, after_snap,
         trace_id, span_id, occurred_at, org_id)
    VALUES (NEW.actor_id, 'employee.home_branch_set', 'employee', NEW.employee_id::text, v_branch,
        jsonb_build_object('home_branch_id', v_old),
        jsonb_build_object('home_branch_id', v_branch, 'assignment_id', NEW.id, 'command_id', NEW.command_id),
        replace(gen_random_uuid()::text, '-', ''), left(replace(gen_random_uuid()::text, '-', ''), 16),
        now(), NEW.org_id);
    RETURN NEW;
END $$;
ALTER FUNCTION leave_api.follow_assignment_branch() OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION leave_api.follow_assignment_branch() FROM PUBLIC, console_rt, console_leave_cmd;
CREATE TRIGGER employment_assignment_home_branch AFTER INSERT ON employment_assignments
    FOR EACH ROW EXECUTE FUNCTION leave_api.follow_assignment_branch();

-- Recheck under the employee lock in the leave command, closing the preflight/write race.
CREATE FUNCTION leave_api.check_placement_branch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.home_branch_id IS DISTINCT FROM OLD.home_branch_id AND EXISTS (
        SELECT 1 FROM public.employment_assignments a
        JOIN public.workplaces w ON w.org_id = a.org_id AND w.id = a.workplace_id
        WHERE a.org_id = NEW.org_id AND a.employee_id = NEW.id AND a.superseded_at IS NULL
          AND a.valid_from <= (now() AT TIME ZONE 'Asia/Seoul')::date
          AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Seoul')::date)
          AND w.default_branch_id IS NOT NULL AND w.default_branch_id <> NEW.home_branch_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'leave_home_branch.not_workplace';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION leave_api.check_placement_branch() FROM PUBLIC;
CREATE TRIGGER employee_placement_home_branch BEFORE UPDATE OF home_branch_id ON employees
    FOR EACH ROW EXECUTE FUNCTION leave_api.check_placement_branch();

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: keep historical decisions and the existing boolean interface.
-- Cedar owns the application decision; SQL enforces the matching invariant.
-- Rollback: deploy the previous binary; retain this fail-closed integrity guard.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION public.console_decision_people(p_org UUID, p_maker UUID, p_checker UUID)
RETURNS TABLE (maker_person UUID, checker_person UUID) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    account RECORD;
    binding RECORD;
    account_count INTEGER := 0;
    maker_employee UUID;
    checker_employee UUID;
BEGIN
    IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::uuid
       OR p_org IS NULL OR p_maker IS NULL OR p_checker IS NULL OR p_maker = p_checker THEN
        RETURN NEXT;
        RETURN;
    END IF;
    FOR account IN
        SELECT u.id, u.employee_id FROM public.users u
        WHERE u.org_id = p_org AND u.id IN (p_maker, p_checker)
        ORDER BY u.id FOR SHARE OF u
    LOOP
        account_count := account_count + 1;
        IF account.id = p_maker THEN maker_employee := account.employee_id;
        ELSE checker_employee := account.employee_id;
        END IF;
    END LOOP;
    IF account_count <> 2 OR (maker_employee IS NOT NULL AND maker_employee = checker_employee) THEN
        RETURN NEXT;
        RETURN;
    END IF;
    -- Lock absent bindings too: a concurrent INSERT needs a foreign-key lock on the employee.
    PERFORM e.id FROM public.employees e
    WHERE e.org_id = p_org AND e.id IN (maker_employee, checker_employee)
    ORDER BY e.id FOR UPDATE OF e;
    FOR binding IN
        SELECT b.employee_id, b.person_id FROM public.employee_person_bindings b
        WHERE b.org_id = p_org AND b.employee_id IN (maker_employee, checker_employee)
        ORDER BY b.employee_id FOR SHARE OF b
    LOOP
        IF binding.employee_id = maker_employee THEN maker_person := binding.person_id;
        ELSE checker_person := binding.person_id;
        END IF;
    END LOOP;
    RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.console_decision_people(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_decision_people(UUID, UUID, UUID)
    TO console_rt, console_leave_definer, console_leave_cmd;

CREATE OR REPLACE FUNCTION public.console_independent_people(p_org UUID, p_maker UUID, p_checker UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT maker_person IS NOT NULL AND checker_person IS NOT NULL
        AND maker_person <> checker_person
    FROM public.console_decision_people(p_org, p_maker, p_checker)
$$;

CREATE FUNCTION public.period_unlock_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_TABLE_NAME = 'period_unlock_requests' THEN
        IF NEW.outcome IN ('APPROVED', 'REJECTED') AND NOT public.console_independent_people(
            NEW.org_id, NEW.requested_by, NEW.decided_by) THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'second_person_required';
        END IF;
    ELSIF NEW.unlock_approved_by IS NOT NULL AND NOT public.console_independent_people(
        NEW.org_id, NEW.unlocked_by, NEW.unlock_approved_by) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'second_person_required';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.period_unlock_person_sod_guard() FROM PUBLIC;
CREATE TRIGGER trg_period_unlock_person_sod BEFORE INSERT OR UPDATE
    ON public.period_unlock_requests FOR EACH ROW
    EXECUTE FUNCTION public.period_unlock_person_sod_guard();
CREATE TRIGGER trg_period_lock_person_sod BEFORE INSERT OR UPDATE
    ON public.period_locks FOR EACH ROW
    EXECUTE FUNCTION public.period_unlock_person_sod_guard();

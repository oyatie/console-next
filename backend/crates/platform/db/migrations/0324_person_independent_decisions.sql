-- Expand only: historical decisions stay untouched; new decisions bind people,
-- not account IDs. Old binaries retain their interfaces and fail safely.
-- Rollback: restore the previous binary; retain these integrity backstops.
-- No upstream migration is imported (their 0226–0231 collide with ours).

-- The migration-owner definer can lock immutable bindings without giving the
-- serving roles an UPDATE privilege. Tenant qualification is checked explicitly.
CREATE FUNCTION public.console_independent_people(p_org UUID, p_maker UUID, p_checker UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    account RECORD;
    person UUID;
    maker_person UUID;
    checker_person UUID;
BEGIN
    IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::uuid
       OR p_org IS NULL OR p_maker IS NULL OR p_checker IS NULL OR p_maker = p_checker THEN
        RETURN FALSE;
    END IF;
    -- Stable ordering keeps concurrent decisions from locking users inversely.
    FOR account IN
        SELECT u.id, u.employee_id FROM public.users u
        WHERE u.org_id = p_org AND u.id IN (p_maker, p_checker)
        ORDER BY u.id FOR SHARE OF u
    LOOP
        SELECT b.person_id INTO person FROM public.employee_person_bindings b
        WHERE b.org_id = p_org AND b.employee_id = account.employee_id
        FOR SHARE OF b;
        IF account.id = p_maker THEN maker_person := person;
        ELSE checker_person := person;
        END IF;
    END LOOP;
    RETURN maker_person IS NOT NULL AND checker_person IS NOT NULL
        AND maker_person <> checker_person;
END $$;
REVOKE ALL ON FUNCTION public.console_independent_people(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_independent_people(UUID, UUID, UUID)
    TO console_rt, console_leave_definer;

CREATE FUNCTION public.payroll_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decided_by IS NOT NULL AND NOT public.console_independent_people(
        NEW.org_id, NEW.submitted_by, NEW.decided_by) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'payroll_decide.sod_violation';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.payroll_person_sod_guard() FROM PUBLIC;
CREATE TRIGGER trg_payroll_person_sod BEFORE INSERT OR UPDATE OF submitted_by, decided_by
    ON public.payroll_draft_runs FOR EACH ROW EXECUTE FUNCTION public.payroll_person_sod_guard();

CREATE FUNCTION leave_api.person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decided_by IS NOT NULL AND NOT public.console_independent_people(
        NEW.org_id, NEW.requester_user_id, NEW.decided_by) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'leave_decide.requester_forbidden';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION leave_api.person_sod_guard() FROM PUBLIC;
CREATE TRIGGER trg_leave_person_sod BEFORE INSERT OR UPDATE OF decided_by
    ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION leave_api.person_sod_guard();

CREATE FUNCTION public.org_change_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.kind = 'org_change_step' AND NEW.decision <> 'pending'
       AND NOT public.console_independent_people(NEW.org_id, NEW.requested_by, NEW.approver_id) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'org_change_decide.sod_violation';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.org_change_person_sod_guard() FROM PUBLIC;
CREATE TRIGGER trg_org_change_person_sod BEFORE INSERT ON public.gov_approvals
    FOR EACH ROW EXECUTE FUNCTION public.org_change_person_sod_guard();

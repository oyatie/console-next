-- Expand: distinct tenant accounts are independent unless they share an identity.
-- Retain the Cedar fact interface, grants and decision triggers; historical rows stay untouched.
-- Rollback: deploy the previous binary; this compatible identity backstop remains.
CREATE OR REPLACE FUNCTION public.console_independent_people(p_org UUID, p_maker UUID, p_checker UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    account RECORD;
    binding RECORD;
    account_count INTEGER := 0;
    maker_employee UUID;
    checker_employee UUID;
    maker_person UUID;
    checker_person UUID;
BEGIN
    IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::uuid
       OR p_org IS NULL OR p_maker IS NULL OR p_checker IS NULL OR p_maker = p_checker THEN
        RETURN FALSE;
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
        RETURN FALSE;
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
    RETURN maker_person IS NULL OR checker_person IS NULL OR maker_person <> checker_person;
END $$;

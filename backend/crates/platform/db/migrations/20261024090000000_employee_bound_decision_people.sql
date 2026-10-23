-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: keep G5's account Persons and historical decisions intact.
-- A Person minted for an account is not evidence of an independent human.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.console_decision_people(p_org UUID,p_maker UUID,p_checker UUID)
RETURNS TABLE (maker_person UUID,checker_person UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account RECORD;
BEGIN
    IF p_org IS NULL OR p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org',true),'')::uuid THEN
        RETURN NEXT; RETURN;
    END IF;
    FOR account IN
        SELECT u.id, CASE WHEN NOT EXISTS (
            SELECT 1 FROM public.person_binding_reviews_open r
            WHERE r.org_id=u.org_id AND (
                (r.subject_kind='ACCOUNT' AND r.subject_id=u.id) OR
                (r.subject_kind='EMPLOYEE' AND r.subject_id=u.employee_id)
            )
        ) THEN b.person_id END AS person_id
        FROM public.users u
        LEFT JOIN public.employee_person_bindings b
            ON b.org_id=u.org_id AND b.employee_id=u.employee_id AND b.person_id=u.person_id
        WHERE u.org_id=p_org AND u.id IN (p_maker,p_checker)
        ORDER BY u.id FOR SHARE OF u
    LOOP
        IF account.id=p_maker THEN maker_person:=account.person_id; END IF;
        IF account.id=p_checker THEN checker_person:=account.person_id; END IF;
    END LOOP;
    RETURN NEXT;
END $$;

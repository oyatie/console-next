-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: retain prior migrations, APIs and immutable historical decisions.
-- Canonical Person bindings are required; accounts are never substitute identities.
-- Rollback: old binaries fail safely; retain the decision evidence and SQL invariant.
SET LOCAL lock_timeout = '2s';

-- One resolver for Cedar, SQL invariants, governance and identity-link self checks.
CREATE OR REPLACE FUNCTION public.console_decision_people(p_org UUID,p_maker UUID,p_checker UUID)
RETURNS TABLE (maker_person UUID,checker_person UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account RECORD;
BEGIN
    IF p_org IS NULL OR p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org',true),'')::uuid THEN
        RETURN NEXT; RETURN;
    END IF;
    FOR account IN
        SELECT u.id,p.id AS person_id FROM public.users u
        LEFT JOIN public.persons p ON p.org_id=u.org_id AND p.id=u.person_id
        WHERE u.org_id=p_org AND u.id IN (p_maker,p_checker)
        ORDER BY u.id FOR SHARE OF u
    LOOP
        IF account.id=p_maker THEN maker_person:=account.person_id; END IF;
        IF account.id=p_checker THEN checker_person:=account.person_id; END IF;
    END LOOP;
    RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.console_independent_people(p_org UUID,p_maker UUID,p_checker UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT maker_person IS NOT NULL AND checker_person IS NOT NULL AND maker_person<>checker_person
    FROM public.console_decision_people(p_org,p_maker,p_checker)
$$;

CREATE FUNCTION public.console_require_independent_people(p_org UUID,p_maker UUID,p_checker UUID,p_domain TEXT,p_same_code TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE facts RECORD;
BEGIN
    SELECT * INTO facts FROM public.console_decision_people(p_org,p_maker,p_checker);
    IF facts.maker_person IS NULL OR facts.checker_person IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE=p_domain||'.refuse.identity_unbound';
    END IF;
    IF NOT public.console_independent_people(p_org,p_maker,p_checker) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE=p_same_code;
    END IF;
    PERFORM set_config('app.sod_decision',jsonb_build_object('org',p_org,'maker',p_maker,'checker',p_checker,
        'maker_person',facts.maker_person,'checker_person',facts.checker_person)::text,true);
END $$;
REVOKE ALL ON FUNCTION public.console_require_independent_people(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_require_independent_people(UUID,UUID,UUID,TEXT,TEXT)
    TO console_rt,console_leave_definer,console_leave_cmd;

CREATE FUNCTION public.capture_sod_audit_identity() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE facts JSONB;
BEGIN
    facts:=NULLIF(current_setting('app.sod_decision',true),'')::jsonb;
    IF facts IS NULL OR NEW.org_id IS DISTINCT FROM (facts->>'org')::uuid
       OR NEW.actor IS DISTINCT FROM (facts->>'checker')::uuid THEN RETURN NEW; END IF;
    NEW.after_snap:=COALESCE(NEW.after_snap,'{}'::jsonb)||jsonb_build_object('independence',facts-'org');
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_sod_audit_identity() FROM PUBLIC;
CREATE TRIGGER trg_sod_audit_identity BEFORE INSERT ON public.audit_events
    FOR EACH ROW EXECUTE FUNCTION public.capture_sod_audit_identity();

CREATE OR REPLACE FUNCTION public.payroll_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decided_by IS NOT NULL THEN
        PERFORM public.console_require_independent_people(NEW.org_id,NEW.submitted_by,NEW.decided_by,'payroll','payroll_decide.sod_violation');
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION leave_api.person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decided_by IS NOT NULL THEN
        PERFORM public.console_require_independent_people(NEW.org_id,NEW.requester_user_id,NEW.decided_by,'leave','leave_decide.requester_forbidden');
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.org_change_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decision <> 'pending' THEN
        PERFORM public.console_require_independent_people(NEW.org_id,NEW.requested_by,NEW.approver_id,
            CASE WHEN NEW.kind='org_change_step' THEN 'org_change' ELSE 'governance' END,
            CASE WHEN NEW.kind='org_change_step' THEN 'org_change_decide.sod_violation' ELSE 'governance.refuse.same_person' END);
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.period_unlock_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE maker UUID; checker UUID;
BEGIN
    IF TG_TABLE_NAME='period_unlock_requests' THEN
        IF NEW.outcome IS NULL OR NEW.outcome NOT IN ('APPROVED','REJECTED') THEN RETURN NEW; END IF;
        maker := NEW.requested_by; checker := NEW.decided_by;
    ELSE
        IF NEW.unlock_approved_by IS NULL THEN RETURN NEW; END IF;
        maker := NEW.unlocked_by; checker := NEW.unlock_approved_by;
    END IF;
    PERFORM public.console_require_independent_people(NEW.org_id,maker,checker,'period_unlock','second_person_required');
    RETURN NEW;
END $$;

CREATE FUNCTION public.account_link_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.status='APPROVED' THEN
        PERFORM public.console_require_independent_people(NEW.org_id,NEW.requested_by,NEW.approved_by,'account_link','account_link_second_person_required');
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.account_link_person_sod_guard() FROM PUBLIC;
CREATE TRIGGER trg_account_link_person_sod BEFORE INSERT OR UPDATE OF status,approved_by
    ON public.account_link_requests FOR EACH ROW EXECUTE FUNCTION public.account_link_person_sod_guard();


-- Serialize the setup-only exception with go-live and concurrent account creation.
CREATE FUNCTION public.console_setup_person(p_org UUID,p_actor UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE phase TEXT;
BEGIN
    IF p_org IS NULL OR p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org',true),'')::uuid THEN
        RETURN false;
    END IF;
    PERFORM id FROM public.organizations WHERE id=p_org FOR UPDATE;
    SELECT t.phase INTO phase FROM public.tenant_phase t WHERE t.org_id=p_org FOR SHARE;
    IF phase IS DISTINCT FROM 'SETUP' THEN RETURN false; END IF;
    RETURN EXISTS (SELECT 1 FROM public.users u JOIN public.persons p ON p.org_id=u.org_id AND p.id=u.person_id
        WHERE u.org_id=p_org AND u.id=p_actor);
END $$;
REVOKE ALL ON FUNCTION public.console_setup_person(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_setup_person(UUID,UUID) TO console_rt;

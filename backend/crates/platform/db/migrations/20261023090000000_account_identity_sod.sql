-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: retain prior migrations, APIs and immutable historical decisions.
-- Known unbound accounts use account identity until the person anchor is available.
-- Rollback: old binaries fail safely; retain the decision evidence and SQL invariant.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION public.console_decision_identities(p_org UUID, p_maker UUID, p_checker UUID)
RETURNS TABLE (maker_identity TEXT, checker_identity TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    account RECORD;
    binding RECORD;
    account_count INTEGER := 0;
    maker_employee UUID;
    checker_employee UUID;
    checker_ops BOOLEAN;
    maker_person UUID;
    checker_person UUID;
BEGIN
    IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::uuid
       OR p_org IS NULL OR p_maker IS NULL OR p_checker IS NULL OR p_maker = p_checker THEN
        RETURN NEXT;
        RETURN;
    END IF;
    FOR account IN
        SELECT u.id, u.employee_id, u.is_tenant_ops FROM public.users u
        WHERE u.org_id = p_org AND u.id IN (p_maker, p_checker)
        ORDER BY u.id FOR SHARE OF u
    LOOP
        account_count := account_count + 1;
        IF account.id = p_maker THEN maker_employee := account.employee_id;
        ELSE checker_employee := account.employee_id; checker_ops := account.is_tenant_ops;
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
    -- Ops may initiate bootstrap requests; it cannot check ordinary tenant decisions.
    maker_identity := CASE WHEN maker_person IS NOT NULL THEN 'person:' || maker_person::text
        ELSE 'account:' || p_maker::text END;
    checker_identity := CASE WHEN checker_ops THEN 'ops:' || p_checker::text
        WHEN checker_person IS NOT NULL THEN 'person:' || checker_person::text ELSE 'account:' || p_checker::text END;
    RETURN NEXT;
END $$;


REVOKE ALL ON FUNCTION public.console_decision_identities(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_decision_identities(UUID,UUID,UUID)
    TO console_rt, console_leave_definer, console_leave_cmd;

CREATE OR REPLACE FUNCTION public.console_independent_people(p_org UUID,p_maker UUID,p_checker UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT COALESCE(maker_identity <> checker_identity AND maker_identity NOT LIKE 'ops:%'
        AND checker_identity NOT LIKE 'ops:%',false)
    FROM public.console_decision_identities(p_org,p_maker,p_checker)
$$;

-- Ops is a separate two-operator break-glass control, never an ordinary tenant decider.
CREATE FUNCTION public.console_period_unlock_independent(p_org UUID,p_maker UUID,p_checker UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT COALESCE(maker_identity <> checker_identity AND maker_identity NOT LIKE 'ops:%',false)
    FROM public.console_decision_identities(p_org,p_maker,p_checker)
$$;
REVOKE ALL ON FUNCTION public.console_period_unlock_independent(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_period_unlock_independent(UUID,UUID,UUID) TO console_rt;

-- Only mutation guards capture these facts; eligibility/read probes leave no review evidence.
CREATE FUNCTION public.console_capture_decision_identity(p_org UUID,p_maker UUID,p_checker UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE facts RECORD; snapshot JSONB;
BEGIN
    SELECT * INTO facts FROM public.console_decision_identities(p_org,p_maker,p_checker);
    IF facts.maker_identity IS NULL OR facts.checker_identity IS NULL THEN
        RAISE EXCEPTION 'decision identity unavailable' USING ERRCODE='42501';
    END IF;
    snapshot := jsonb_build_object(
        'sod.maker.' || split_part(facts.maker_identity,':',1), split_part(facts.maker_identity,':',2),
        'sod.checker.' || split_part(facts.checker_identity,':',1), split_part(facts.checker_identity,':',2),
        'sod.review_required', CASE WHEN facts.maker_identity LIKE 'account:%' OR facts.checker_identity LIKE 'account:%' THEN 1 ELSE 0 END);
    PERFORM set_config('app.sod_decision',jsonb_build_object('org',p_org,'maker',p_maker,'checker',p_checker,
        'maker_identity',facts.maker_identity,'checker_identity',facts.checker_identity,'snapshot',snapshot)::text,true);
END $$;
REVOKE ALL ON FUNCTION public.console_capture_decision_identity(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_capture_decision_identity(UUID,UUID,UUID)
    TO console_rt, console_leave_definer, console_leave_cmd;

CREATE FUNCTION public.capture_sod_audit_identity() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE facts JSONB;
BEGIN
    facts := NULLIF(current_setting('app.sod_decision',true),'')::jsonb;
    IF facts IS NULL OR NEW.org_id IS DISTINCT FROM (facts->>'org')::uuid
       OR NEW.actor IS DISTINCT FROM (facts->>'checker')::uuid THEN RETURN NEW; END IF;
    NEW.decision_snapshot := COALESCE(NEW.decision_snapshot,'{}'::jsonb) || (facts->'snapshot');
    NEW.after_snap := COALESCE(NEW.after_snap,'{}'::jsonb) || jsonb_build_object('independence',
        jsonb_build_object('maker',facts->>'maker','checker',facts->>'checker',
            'maker_identity',facts->>'maker_identity','checker_identity',facts->>'checker_identity',
            'review_required',(facts->'snapshot'->>'sod.review_required')::int = 1));
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_sod_audit_identity() FROM PUBLIC;
CREATE TRIGGER trg_sod_audit_identity BEFORE INSERT ON public.audit_events
    FOR EACH ROW EXECUTE FUNCTION public.capture_sod_audit_identity();
COMMENT ON COLUMN audit_events.decision_snapshot IS 'pd:personal — policy versions and the strongest available SoD identities; account identity requires HR review';

CREATE OR REPLACE FUNCTION public.payroll_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decided_by IS NOT NULL THEN
        IF NOT public.console_independent_people(NEW.org_id,NEW.submitted_by,NEW.decided_by) THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='payroll_decide.sod_violation';
        END IF;
        PERFORM public.console_capture_decision_identity(NEW.org_id,NEW.submitted_by,NEW.decided_by);
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION leave_api.person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.decided_by IS NOT NULL THEN
        IF NOT public.console_independent_people(NEW.org_id,NEW.requester_user_id,NEW.decided_by) THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='leave_decide.requester_forbidden';
        END IF;
        PERFORM public.console_capture_decision_identity(NEW.org_id,NEW.requester_user_id,NEW.decided_by);
    END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.org_change_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.kind='org_change_step' AND NEW.decision <> 'pending' THEN
        IF NOT public.console_independent_people(NEW.org_id,NEW.requested_by,NEW.approver_id) THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='org_change_decide.sod_violation';
        END IF;
        PERFORM public.console_capture_decision_identity(NEW.org_id,NEW.requested_by,NEW.approver_id);
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
    IF NOT public.console_period_unlock_independent(NEW.org_id,maker,checker) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='second_person_required';
    END IF;
    PERFORM public.console_capture_decision_identity(NEW.org_id,maker,checker);
    RETURN NEW;
END $$;

CREATE FUNCTION public.account_link_person_sod_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.status='APPROVED' THEN
        IF NOT public.console_independent_people(NEW.org_id,NEW.requested_by,NEW.approved_by) THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='account_link_second_person_required';
        END IF;
        PERFORM public.console_capture_decision_identity(NEW.org_id,NEW.requested_by,NEW.approved_by);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.account_link_person_sod_guard() FROM PUBLIC;
CREATE TRIGGER trg_account_link_person_sod BEFORE INSERT OR UPDATE OF status,approved_by
    ON public.account_link_requests FOR EACH ROW EXECUTE FUNCTION public.account_link_person_sod_guard();

-- The Home review read follows account IDs, without scanning unrelated audit history.
CREATE INDEX audit_events_sod_maker_account ON public.audit_events
    (org_id,(decision_snapshot->>'sod.maker.account'))
    WHERE decision_snapshot->>'sod.maker.account' IS NOT NULL;
CREATE INDEX audit_events_sod_checker_account ON public.audit_events
    (org_id,(decision_snapshot->>'sod.checker.account'))
    WHERE decision_snapshot->>'sod.checker.account' IS NOT NULL;

-- Reuse the account topic so Home refreshes after decisions and later person linking.
INSERT INTO realtime_topic_map (target_type,action,resource_type,carries_id) VALUES
    ('org_change_approval_step','org_change.step.decide','user',false),
    ('period_lock','period_lock.unlock','user',false),
    ('period_lock','period_lock.unlock_reject','user',false),
    ('leave_request','leave_request.decide','user',false),
    ('payroll_draft_run','payroll_run.decide','user',false),
    ('user','account_link.approved','user',false),
    ('employee','employee.identity_resolve','user',false)
ON CONFLICT DO NOTHING;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: retain prior migrations, APIs and immutable historical decisions.
-- Canonical Person bindings are required; accounts are never substitute identities.
-- Rollback: old binaries fail safely; retain the decision evidence and SQL invariant.
SET LOCAL lock_timeout = '2s';

-- Expand the operations principal shape to admit an explicitly bound bootstrap Person.
-- Ordinary operations inserts still have no Person; the decision resolver never invents one.
ALTER TABLE users DROP CONSTRAINT users_principal_person_check;
ALTER TABLE users ADD CONSTRAINT users_principal_person_check CHECK (
    (principal_kind='TENANT_PERSON' AND person_id IS NOT NULL AND NOT is_tenant_ops)
    OR (principal_kind='OPERATIONS' AND is_tenant_ops)
    OR (principal_kind='VENDOR' AND person_id IS NULL AND NOT is_tenant_ops)
) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_principal_person_check;

CREATE OR REPLACE FUNCTION console_account_binding() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE linked UUID; attrs JSONB;
BEGIN
    IF TG_OP='UPDATE' AND public.console_person_erasing() THEN RETURN NEW; END IF;
    IF NEW.is_tenant_ops THEN NEW.principal_kind:='OPERATIONS';
    ELSIF EXISTS(SELECT 1 FROM public.organizations WHERE id=NEW.org_id AND slug='platform') THEN NEW.principal_kind:='VENDOR';
    ELSE NEW.principal_kind:='TENANT_PERSON'; END IF;
    IF NEW.principal_kind<>'TENANT_PERSON' THEN
        IF NEW.principal_kind='VENDOR' OR (TG_OP='UPDATE' AND NOT OLD.is_tenant_ops) THEN
            NEW.person_id:=NULL;
        ELSIF TG_OP='UPDATE' AND OLD.person_id IS NOT NULL AND NEW.person_id IS NULL THEN
            NEW.person_id:=OLD.person_id;
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP='INSERT' OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
      OR OLD.principal_kind<>'TENANT_PERSON' THEN
        IF NEW.employee_id IS NOT NULL THEN
            linked:=public.console_bind_employee_person(NEW.org_id,NEW.employee_id,NULL);
            NEW.person_id:=linked;
        ELSIF TG_OP='INSERT' AND NEW.person_id IS NOT NULL THEN
            IF NOT EXISTS(SELECT 1 FROM public.persons WHERE org_id=NEW.org_id AND id=NEW.person_id) THEN
                RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='person binding is not in this tenant';
            END IF;
        END IF;
        IF NEW.person_id IS NULL THEN NEW.person_id:=NEW.id; END IF;
        attrs:=public.console_person_facts(NEW.org_id,NEW.person_id);
        IF attrs IS NOT NULL THEN
            NEW.display_name:=coalesce(attrs->>'display_name',attrs->>'legal_name',NEW.display_name);
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Existing tenant bootstrap operations accounts use G5's binding provenance, with no invented actor.
DO $$ DECLARE u RECORD; bound UUID; previous TEXT:=current_setting('app.current_org',true); BEGIN
    FOR u IN SELECT id,org_id,employee_id,display_name,phone FROM public.users
        WHERE is_tenant_ops AND person_id IS NULL ORDER BY org_id,id FOR UPDATE LOOP
        PERFORM set_config('app.current_org',u.org_id::text,true);
        bound:=COALESCE(public.console_employee_person(u.org_id,u.employee_id),u.id);
        INSERT INTO public.persons(org_id,id) VALUES(u.org_id,bound) ON CONFLICT DO NOTHING;
        UPDATE public.users SET person_id=bound WHERE id=u.id AND org_id=u.org_id;
        IF public.console_person_facts(u.org_id,bound) IS NULL THEN
            PERFORM public.console_revise_person_facts(u.org_id,bound,
                jsonb_build_object('legal_name',u.display_name,'phone',u.phone),NULL);
        END IF;
    END LOOP;
    PERFORM set_config('app.current_org',COALESCE(previous,''),true);
END $$;

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
CREATE FUNCTION public.console_setup_phase(p_org UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE phase TEXT;
BEGIN
    IF p_org IS NULL OR p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org',true),'')::uuid THEN
        RETURN false;
    END IF;
    SELECT t.phase INTO phase FROM public.tenant_phase t WHERE t.org_id=p_org FOR SHARE;
    IF phase IS DISTINCT FROM 'SETUP' THEN RETURN false; END IF;
    PERFORM id FROM public.organizations WHERE id=p_org FOR UPDATE;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.console_setup_phase(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_setup_phase(UUID) TO console_rt;

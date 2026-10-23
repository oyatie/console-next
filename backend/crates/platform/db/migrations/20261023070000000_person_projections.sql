-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Person owns human facts. Retained N-1 columns are transactionally current projections.
-- The erasure marker is meaningful only inside the trusted destruction definer.
CREATE FUNCTION console_person_erasing() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT (current_setting('app.pii_destruction',true)='on'
      AND current_user=pg_get_userbyid((SELECT proowner FROM pg_proc
        WHERE oid='public.employee_void_destroy_pii(uuid,boolean)'::regprocedure)))
      OR (current_setting('app.platform_force_remove_org',true)='on'
      AND current_user=pg_get_userbyid((SELECT proowner FROM pg_proc
        WHERE oid='public.platform_force_remove_organization(uuid)'::regprocedure)))
$$;
CREATE OR REPLACE FUNCTION console_account_binding() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE linked UUID; attrs JSONB;
BEGIN
    IF TG_OP='UPDATE' AND public.console_person_erasing() THEN RETURN NEW; END IF;
    IF NEW.is_tenant_ops THEN NEW.principal_kind:='OPERATIONS';
    ELSIF EXISTS(SELECT 1 FROM public.organizations WHERE id=NEW.org_id AND slug='platform') THEN NEW.principal_kind:='VENDOR';
    ELSE NEW.principal_kind:='TENANT_PERSON'; END IF;
    IF NEW.principal_kind<>'TENANT_PERSON' THEN
        NEW.person_id:=NULL;
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
            NEW.phone:=attrs->>'phone';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION console_person_legacy_employee_facts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person UUID; patch JSONB:='{}'::JSONB;
BEGIN
    IF public.console_person_erasing() THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='employees' THEN
        person:=public.console_employee_person(NEW.org_id,NEW.id);
    ELSE
        person:=public.console_employee_person(NEW.org_id,NEW.employee_id);
    END IF;
    IF person IS NULL THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='employees' THEN
        IF NEW.name IS DISTINCT FROM OLD.name THEN patch:=patch||jsonb_build_object('legal_name',NEW.name); END IF;
        IF NEW.birth_date IS DISTINCT FROM OLD.birth_date THEN patch:=patch||jsonb_build_object('birth_date',NEW.birth_date); END IF;
        PERFORM public.console_revise_person_facts(NEW.org_id,person,patch,NULL);
    ELSE
        IF (TG_OP='INSERT' AND NEW.phone_e164 IS NOT NULL) OR (TG_OP='UPDATE' AND NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164) THEN
            PERFORM public.console_revise_person_facts(NEW.org_id,person,jsonb_build_object('phone',NEW.phone_e164),NULL);
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER person_employee_facts ON employees;
CREATE TRIGGER person_employee_facts AFTER UPDATE OF name,birth_date ON employees
    FOR EACH ROW EXECUTE FUNCTION console_person_legacy_employee_facts();
DROP TRIGGER person_employee_phone ON employee_employment_profiles;
CREATE TRIGGER person_employee_phone AFTER INSERT OR UPDATE OF phone_e164 ON employee_employment_profiles
    FOR EACH ROW EXECUTE FUNCTION console_person_legacy_employee_facts();

-- A narrow definer projects only a bound person's facts, including for isolated command roles.
CREATE FUNCTION console_project_person_facts(p_org UUID,p_person UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE attrs JSONB;
BEGIN
    attrs:=public.console_person_facts(p_org,p_person);
    IF attrs IS NULL THEN RETURN; END IF;
    UPDATE public.employees e SET name=coalesce(attrs->>'legal_name',e.name),
        birth_date=CASE WHEN attrs ? 'birth_date' THEN (attrs->>'birth_date')::DATE ELSE e.birth_date END
    FROM public.employee_person_bindings b
    WHERE b.org_id=p_org AND b.person_id=p_person AND e.org_id=b.org_id AND e.id=b.employee_id
      AND e.pii_destroyed_at IS NULL
      AND (e.name IS DISTINCT FROM coalesce(attrs->>'legal_name',e.name)
        OR (attrs ? 'birth_date' AND e.birth_date IS DISTINCT FROM (attrs->>'birth_date')::DATE));
    UPDATE public.employee_employment_profiles p SET phone_e164=attrs->>'phone'
    FROM public.employee_person_bindings b JOIN public.employees e ON e.org_id=b.org_id AND e.id=b.employee_id
    WHERE b.org_id=p_org AND b.person_id=p_person AND p.org_id=b.org_id AND p.employee_id=b.employee_id
      AND e.pii_destroyed_at IS NULL AND p.phone_e164 IS DISTINCT FROM attrs->>'phone';
    UPDATE public.users u SET display_name=coalesce(attrs->>'display_name',attrs->>'legal_name',u.display_name),phone=attrs->>'phone'
    WHERE u.org_id=p_org AND u.person_id=p_person
      AND (u.display_name IS DISTINCT FROM coalesce(attrs->>'display_name',attrs->>'legal_name',u.display_name)
        OR u.phone IS DISTINCT FROM attrs->>'phone');
END $$;
REVOKE ALL ON FUNCTION console_project_person_facts(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_project_person_facts(UUID,UUID) TO console_rt,console_leave_definer,console_ontology_writer;

CREATE FUNCTION console_project_person_revision() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    PERFORM public.console_project_person_facts(NEW.org_id,NEW.person_id);
    RETURN NEW;
END $$;
CREATE TRIGGER person_project_revision AFTER INSERT ON person_revisions
    FOR EACH ROW EXECUTE FUNCTION console_project_person_revision();

CREATE FUNCTION console_account_fact_write() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE attrs JSONB; patch JSONB:='{}'::JSONB;
BEGIN
    IF NEW.person_id IS NULL OR public.console_person_erasing() THEN RETURN NEW; END IF;
    attrs:=public.console_person_facts(NEW.org_id,NEW.person_id);
    IF TG_OP='UPDATE' AND NEW.person_id IS NOT DISTINCT FROM OLD.person_id THEN
        IF NEW.display_name IS DISTINCT FROM OLD.display_name
          AND NEW.display_name IS DISTINCT FROM coalesce(attrs->>'display_name',attrs->>'legal_name') THEN
            patch:=patch||jsonb_build_object('display_name',NEW.display_name);
        END IF;
        IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS DISTINCT FROM attrs->>'phone' THEN
            patch:=patch||jsonb_build_object('phone',NEW.phone);
        END IF;
        IF patch<>'{}'::JSONB THEN
            PERFORM public.console_revise_person_facts(NEW.org_id,NEW.person_id,patch,NULL);
        END IF;
    END IF;
    PERFORM public.console_project_person_facts(NEW.org_id,NEW.person_id);
    RETURN NEW;
END $$;
-- A linked employment seeds its Person; an unlinked account seeds its own.
CREATE OR REPLACE FUNCTION console_account_person_initial_facts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF public.console_person_erasing() THEN RETURN NEW; END IF;
    IF NEW.person_id IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM public.persons WHERE org_id=NEW.org_id AND id=NEW.person_id) THEN
            INSERT INTO public.persons(org_id,id) VALUES(NEW.org_id,NEW.person_id);
        END IF;
        IF NEW.employee_id IS NULL AND public.console_person_facts(NEW.org_id,NEW.person_id) IS NULL THEN
            PERFORM public.console_revise_person_facts(NEW.org_id,NEW.person_id,
                jsonb_build_object('legal_name',NEW.display_name,'phone',NEW.phone),NULL);
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- An ops handover demotes the former operator to a tenant account in the same transaction.
DROP TRIGGER person_account_initial_facts ON users;
CREATE TRIGGER person_account_initial_facts AFTER INSERT OR UPDATE OF person_id,employee_id,is_tenant_ops ON users
    FOR EACH ROW EXECUTE FUNCTION console_account_person_initial_facts();
CREATE TRIGGER person_account_write AFTER INSERT OR UPDATE OF display_name,phone,person_id,employee_id,is_tenant_ops ON users
    FOR EACH ROW EXECUTE FUNCTION console_account_fact_write();

CREATE OR REPLACE FUNCTION console_sync_employee_accounts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    UPDATE public.users SET person_id=NEW.person_id
    WHERE org_id=NEW.org_id AND employee_id=NEW.employee_id AND person_id IS DISTINCT FROM NEW.person_id;
    PERFORM public.console_project_person_facts(NEW.org_id,NEW.person_id);
    RETURN NEW;
END $$;

DO $$ DECLARE person RECORD; BEGIN
    FOR person IN SELECT DISTINCT ON (org_id,person_id) org_id,person_id,attributes
      FROM person_revisions ORDER BY org_id,person_id,version DESC LOOP
        PERFORM console_project_person_facts(person.org_id,person.person_id);
    END LOOP;
END $$;

-- The existing immutable verdict and account link determine whether evidence still needs action.
CREATE VIEW person_binding_reviews_open WITH (security_invoker=true) AS
    SELECT r.* FROM person_binding_reviews r
    WHERE NOT EXISTS(SELECT 1 FROM employee_identity_resolutions d WHERE r.subject_kind='EMPLOYEE'
        AND d.org_id=r.org_id AND d.employee_id=r.subject_id AND d.created_at>=r.created_at)
      AND NOT (r.subject_kind='ACCOUNT' AND r.reason='EMPLOYEE_LINK_MISSING' AND EXISTS
        (SELECT 1 FROM users u WHERE u.org_id=r.org_id AND u.id=r.subject_id AND u.employee_id IS NOT NULL));
GRANT SELECT ON person_binding_reviews_open TO console_rt;

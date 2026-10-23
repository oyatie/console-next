-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Account conflict paths must not allocate orphan Persons before the insert wins.
ALTER TABLE users ALTER CONSTRAINT users_person_fk DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION console_account_binding() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE linked UUID; patch JSONB:='{}'::JSONB;
BEGIN
    IF TG_OP='UPDATE' AND current_setting('app.pii_destruction',true)='on' THEN RETURN NEW; END IF;
    IF NEW.is_tenant_ops THEN NEW.principal_kind:='OPERATIONS';
    ELSIF EXISTS(SELECT 1 FROM public.organizations WHERE id=NEW.org_id AND slug='platform') THEN NEW.principal_kind:='VENDOR';
    ELSE NEW.principal_kind:='TENANT_PERSON'; END IF;
    IF NEW.principal_kind<>'TENANT_PERSON' THEN
        NEW.person_id:=NULL;
        RETURN NEW;
    END IF;
    IF TG_OP='INSERT' OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
        IF NEW.employee_id IS NOT NULL THEN
            linked:=public.console_bind_employee_person(NEW.org_id,NEW.employee_id,NULL);
            NEW.person_id:=linked;
        ELSIF TG_OP='INSERT' AND NEW.person_id IS NOT NULL THEN
            IF NOT EXISTS(SELECT 1 FROM public.persons WHERE org_id=NEW.org_id AND id=NEW.person_id) THEN
                RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='person binding is not in this tenant';
            END IF;
        END IF;
        IF TG_OP='INSERT' AND NEW.person_id IS NULL THEN NEW.person_id:=NEW.id; END IF;
    END IF;
    IF TG_OP='UPDATE' AND NEW.person_id IS NOT NULL THEN
        IF NEW.display_name IS DISTINCT FROM OLD.display_name THEN patch:=patch||jsonb_build_object('display_name',NEW.display_name); END IF;
        IF NEW.phone IS DISTINCT FROM OLD.phone THEN patch:=patch||jsonb_build_object('phone',NEW.phone); END IF;
        IF patch<>'{}'::JSONB THEN
            PERFORM public.console_revise_person_facts(NEW.org_id,NEW.person_id,patch,NEW.id);
            NEW.display_name:=OLD.display_name;
            NEW.phone:=OLD.phone;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION console_account_person_initial_facts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF NEW.person_id IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM public.persons WHERE org_id=NEW.org_id AND id=NEW.person_id) THEN
            INSERT INTO public.persons(org_id,id) VALUES(NEW.org_id,NEW.person_id);
        END IF;
        IF public.console_person_facts(NEW.org_id,NEW.person_id) IS NULL THEN
            PERFORM public.console_revise_person_facts(NEW.org_id,NEW.person_id,
                jsonb_build_object('legal_name',NEW.display_name,'phone',NEW.phone),NEW.id);
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- The private post-eligibility removal hook releases actor edges before users.
-- Person anchors remain until the organization cascade, preserving users' FK.
CREATE OR REPLACE FUNCTION auth_security.retire_company_accounts(p_org UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=off AS $$
DECLARE account UUID; previous TEXT:=current_setting('app.person_erasure_org',true);
BEGIN
    FOR account IN SELECT id FROM public.users WHERE org_id=p_org ORDER BY id LOOP
        PERFORM auth_security.retire_account_id(account);
    END LOOP;
    PERFORM set_config('app.person_erasure_org',p_org::TEXT,true);
    DELETE FROM public.employee_person_bindings WHERE org_id=p_org;
    DELETE FROM public.person_revisions WHERE org_id=p_org;
    PERFORM set_config('app.person_erasure_org',coalesce(previous,''),true);
END $$;

CREATE OR REPLACE FUNCTION canonical_person_row_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF TG_OP='DELETE' AND current_setting('app.person_erasure_org',true)=OLD.org_id::TEXT
       AND CURRENT_USER=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME='person_revisions' AND TG_OP='UPDATE'
       AND current_setting('app.pii_destruction',true)='on'
       AND (NEW.org_id,NEW.id,NEW.person_id,NEW.version,NEW.command_id,NEW.actor_id,
            NEW.payload_digest,NEW.created_at,NEW.origin)
           IS NOT DISTINCT FROM
           (OLD.org_id,OLD.id,OLD.person_id,OLD.version,OLD.command_id,OLD.actor_id,
            OLD.payload_digest,OLD.created_at,OLD.origin) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'canonical person table %: % is refused, the row is immutable',TG_TABLE_NAME,TG_OP;
END $$;

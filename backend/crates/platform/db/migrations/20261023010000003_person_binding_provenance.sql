-- SPDX-License-Identifier: LicenseRef-Proprietary
-- A compatibility projection knows its subject, not the human who submitted it.
-- Explicit Person commands and outer command audits retain the actual actor.
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
            PERFORM public.console_revise_person_facts(NEW.org_id,NEW.person_id,patch,NULL);
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
                jsonb_build_object('legal_name',NEW.display_name,'phone',NEW.phone),NULL);
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION console_person_legacy_employee_facts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE person UUID; patch JSONB:='{}'::JSONB;
BEGIN
    IF current_setting('app.pii_destruction',true)='on' THEN RETURN NEW; END IF;
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
        NEW.name:=OLD.name; NEW.birth_date:=OLD.birth_date;
    ELSE
        IF (TG_OP='INSERT' AND NEW.phone_e164 IS NOT NULL) OR (TG_OP='UPDATE' AND NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164) THEN
            PERFORM public.console_revise_person_facts(NEW.org_id,person,jsonb_build_object('phone',NEW.phone_e164),NULL);
        END IF;
        IF TG_OP='UPDATE' THEN NEW.phone_e164:=OLD.phone_e164; END IF;
    END IF;
    RETURN NEW;
END $$;

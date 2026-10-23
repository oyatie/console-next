-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only. Old binaries can still supply the legacy name/phone columns.
-- Binding runs in the writer's transaction; updates are redirected to Person.
ALTER TABLE users ADD COLUMN person_id UUID;
ALTER TABLE users ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'TENANT_PERSON';
ALTER TABLE users ADD CONSTRAINT users_person_fk FOREIGN KEY (org_id,person_id)
    REFERENCES persons(org_id,id) NOT VALID;
ALTER TABLE users ADD CONSTRAINT users_principal_person_check CHECK (
    (principal_kind='TENANT_PERSON' AND person_id IS NOT NULL AND NOT is_tenant_ops)
    OR (principal_kind='OPERATIONS' AND person_id IS NULL AND is_tenant_ops)
    OR (principal_kind='VENDOR' AND person_id IS NULL AND NOT is_tenant_ops)
) NOT VALID;
CREATE INDEX users_person_idx ON users(org_id,person_id);
COMMENT ON COLUMN users.person_id IS 'pd:personal — canonical natural person of a tenant account';
COMMENT ON COLUMN users.principal_kind IS 'pd:personal — tenant person, operations, or vendor principal';

-- A migration is a system action, never attributed to an invented human.
ALTER TABLE person_revisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'command';
ALTER TABLE person_revisions ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE person_revisions ADD CONSTRAINT person_revision_origin CHECK (
    origin IN ('command','binding') AND (actor_id IS NOT NULL OR origin='binding'));
ALTER TABLE employee_person_bindings ADD COLUMN origin TEXT NOT NULL DEFAULT 'command';
ALTER TABLE employee_person_bindings ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE employee_person_bindings ADD CONSTRAINT employee_person_origin CHECK (
    origin IN ('command','binding') AND (actor_id IS NOT NULL OR origin='binding'));
COMMENT ON COLUMN person_revisions.origin IS 'pd:personal — provenance of a human fact revision';
COMMENT ON COLUMN employee_person_bindings.origin IS 'pd:personal — provenance of a human binding';

CREATE TABLE person_binding_reviews (
    org_id UUID NOT NULL REFERENCES organizations(id),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('EMPLOYEE','ACCOUNT')),
    subject_id UUID NOT NULL,
    reason TEXT NOT NULL,
    evidence JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id,subject_kind,subject_id)
);
ALTER TABLE person_binding_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_binding_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON person_binding_reviews
    USING (org_id=NULLIF(current_setting('app.current_org',true),'')::UUID)
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::UUID);
REVOKE ALL ON person_binding_reviews FROM PUBLIC, console_rt;
GRANT SELECT,INSERT ON person_binding_reviews TO console_rt;
COMMENT ON COLUMN person_binding_reviews.org_id IS 'pd:personal — tenant of an identity review';
COMMENT ON COLUMN person_binding_reviews.subject_kind IS 'pd:personal — reviewed record kind';
COMMENT ON COLUMN person_binding_reviews.subject_id IS 'pd:personal — employee or account needing review';
COMMENT ON COLUMN person_binding_reviews.reason IS 'pd:personal — identity ambiguity reason';
COMMENT ON COLUMN person_binding_reviews.evidence IS 'pd:personal,undeclared — candidate IDs and birth-date matching evidence; no RRN';
COMMENT ON COLUMN person_binding_reviews.created_at IS 'pd:personal — identity review creation time';

CREATE FUNCTION console_person_facts(p_org UUID,p_person UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT r.attributes FROM public.person_revisions r
    WHERE r.org_id=p_org AND r.person_id=p_person ORDER BY r.version DESC LIMIT 1
$$;
CREATE FUNCTION console_employee_person(p_org UUID,p_employee UUID) RETURNS UUID
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT b.person_id FROM public.employee_person_bindings b
    WHERE b.org_id=p_org AND b.employee_id=p_employee
$$;
CREATE FUNCTION console_employee_facts(p_org UUID,p_employee UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT public.console_person_facts(p_org,public.console_employee_person(p_org,p_employee))
$$;

-- The advisory lock serializes revisions without granting UPDATE on immutable anchors.
CREATE FUNCTION console_revise_person_facts(p_org UUID,p_person UUID,p_patch JSONB,p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE attrs JSONB; next_version BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_org::TEXT||':person:'||p_person::TEXT,0));
    IF NOT EXISTS (SELECT 1 FROM public.persons WHERE org_id=p_org AND id=p_person) THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='person binding is not in this tenant';
    END IF;
    SELECT r.attributes,r.version+1 INTO attrs,next_version FROM public.person_revisions r
    WHERE r.org_id=p_org AND r.person_id=p_person ORDER BY r.version DESC LIMIT 1;
    IF attrs IS NOT NULL AND attrs=attrs||p_patch THEN RETURN; END IF;
    attrs:=coalesce(attrs,'{}'::JSONB)||p_patch;
    INSERT INTO public.person_revisions
        (org_id,person_id,version,command_id,actor_id,payload_digest,attributes,receipt,origin)
    VALUES (p_org,p_person,coalesce(next_version,1),gen_random_uuid(),p_actor,
        public.digest(attrs::TEXT,'sha256'),attrs,
        jsonb_build_object('person_id',p_person,'origin','binding'),'binding');
END $$;

CREATE FUNCTION console_bind_employee_person(p_org UUID,p_employee UUID,p_actor UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e public.employees%ROWTYPE; bound UUID; candidates JSONB; matching UUID[];
    ambiguous BOOLEAN; attrs JSONB; phone TEXT;
BEGIN
    SELECT * INTO STRICT e FROM public.employees WHERE org_id=p_org AND id=p_employee;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_org::TEXT||':employee-number:'||coalesce(nullif(btrim(e.employee_number),''),e.id::TEXT),0));
    SELECT * INTO STRICT e FROM public.employees WHERE org_id=p_org AND id=p_employee FOR UPDATE;
    SELECT b.person_id INTO bound FROM public.employee_person_bindings b WHERE b.org_id=p_org AND b.employee_id=e.id;
    SELECT jsonb_agg(jsonb_build_object('employee_id',c.id,'birth_date',c.birth_date) ORDER BY c.id),
        bool_or(c.birth_date IS NULL OR e.birth_date IS NULL OR c.birth_date<>e.birth_date OR c.identity_review_required),
        array_agg(DISTINCT b.person_id) FILTER (WHERE b.person_id IS NOT NULL)
    INTO candidates,ambiguous,matching
    FROM public.employees c LEFT JOIN public.employee_person_bindings b ON b.org_id=c.org_id AND b.employee_id=c.id
    WHERE c.org_id=p_org AND nullif(btrim(c.employee_number),'')=nullif(btrim(e.employee_number),'');
    ambiguous:=e.identity_review_required OR (jsonb_array_length(coalesce(candidates,'[]'::JSONB))>1
        AND (coalesce(ambiguous,true) OR coalesce(cardinality(matching),0)>1));
    IF ambiguous THEN
        INSERT INTO public.person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence)
        VALUES(p_org,'EMPLOYEE',e.id,'NUMBER_BIRTH_AMBIGUOUS',jsonb_build_object(
            'employee_number',e.employee_number,'birth_date',e.birth_date,'candidates',coalesce(candidates,'[]'::JSONB)))
        ON CONFLICT DO NOTHING;
    END IF;
    IF bound IS NULL THEN
        IF NOT ambiguous AND e.birth_date IS NOT NULL AND cardinality(matching)=1 THEN
            bound:=matching[1];
        ELSE
            bound:=e.id;
            INSERT INTO public.persons(org_id,id) VALUES(p_org,bound) ON CONFLICT DO NOTHING;
        END IF;
        INSERT INTO public.employee_person_bindings(org_id,employee_id,person_id,actor_id,payload_digest,origin)
        VALUES(p_org,e.id,bound,p_actor,public.digest(e.id::TEXT||':'||bound::TEXT,'sha256'),'binding');
    END IF;
    attrs:=coalesce(public.console_person_facts(p_org,bound),'{}'::JSONB);
    SELECT p.phone_e164 INTO phone FROM public.employee_employment_profiles p WHERE p.org_id=p_org AND p.employee_id=e.id;
    PERFORM public.console_revise_person_facts(p_org,bound,
        (CASE WHEN attrs ? 'legal_name' THEN '{}'::JSONB ELSE jsonb_build_object('legal_name',e.name) END)
        ||(CASE WHEN attrs ? 'birth_date' THEN '{}'::JSONB ELSE jsonb_build_object('birth_date',e.birth_date) END)
        ||(CASE WHEN attrs ? 'phone' OR phone IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('phone',phone) END),p_actor);
    RETURN bound;
END $$;

CREATE FUNCTION console_account_binding() RETURNS TRIGGER
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
        END IF;
        IF TG_OP='INSERT' AND NEW.person_id IS NULL THEN
            NEW.person_id:=NEW.id;
            INSERT INTO public.persons(org_id,id) VALUES(NEW.org_id,NEW.person_id);
        END IF;
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
CREATE TRIGGER person_bind_account BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION console_account_binding();

CREATE FUNCTION console_account_person_initial_facts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF NEW.person_id IS NOT NULL AND public.console_person_facts(NEW.org_id,NEW.person_id) IS NULL THEN
        PERFORM public.console_revise_person_facts(NEW.org_id,NEW.person_id,
            jsonb_build_object('legal_name',NEW.display_name,'phone',NEW.phone),NEW.id);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER person_account_initial_facts AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION console_account_person_initial_facts();

CREATE FUNCTION console_person_legacy_employee_facts() RETURNS TRIGGER
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
            PERFORM public.console_revise_person_facts(NEW.org_id,person,jsonb_build_object('phone',NEW.phone_e164),NEW.created_by);
        END IF;
        IF TG_OP='UPDATE' THEN NEW.phone_e164:=OLD.phone_e164; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER person_employee_facts BEFORE UPDATE OF name,birth_date ON employees
    FOR EACH ROW EXECUTE FUNCTION console_person_legacy_employee_facts();
CREATE TRIGGER person_employee_phone BEFORE INSERT OR UPDATE OF phone_e164 ON employee_employment_profiles
    FOR EACH ROW EXECUTE FUNCTION console_person_legacy_employee_facts();

-- Command-only employee writers run as this role; direct Person-port creates
-- already bind explicitly. This also covers the retained N-1 leave create API.
CREATE FUNCTION console_bind_command_employee() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    PERFORM public.console_bind_employee_person(NEW.org_id,NEW.id,NULL);
    RETURN NEW;
END $$;
CREATE TRIGGER person_bind_import_employee AFTER INSERT ON employees
    FOR EACH ROW WHEN (current_user='console_leave_definer')
    EXECUTE FUNCTION console_bind_command_employee();

CREATE FUNCTION console_sync_employee_accounts() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    UPDATE public.users SET person_id=NEW.person_id
    WHERE org_id=NEW.org_id AND employee_id=NEW.employee_id AND person_id IS DISTINCT FROM NEW.person_id;
    RETURN NEW;
END $$;
CREATE TRIGGER person_sync_employee_accounts AFTER INSERT ON employee_person_bindings
    FOR EACH ROW EXECUTE FUNCTION console_sync_employee_accounts();

CREATE FUNCTION console_backfill_person_bindings(p_org UUID) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE employee RECORD; u RECORD; candidates JSONB; include_voided TEXT:=current_setting('app.include_voided',true);
BEGIN
    PERFORM set_config('app.include_voided','on',true);
    PERFORM pg_advisory_xact_lock(hashtextextended(p_org::TEXT||':person-backfill',0));
    FOR employee IN SELECT id FROM public.employees WHERE org_id=p_org ORDER BY id LOOP
        PERFORM public.console_bind_employee_person(p_org,employee.id,NULL);
    END LOOP;
    FOR u IN SELECT * FROM public.users WHERE org_id=p_org ORDER BY id FOR UPDATE LOOP
        IF u.is_tenant_ops OR EXISTS(SELECT 1 FROM public.organizations WHERE id=p_org AND slug='platform') THEN
            UPDATE public.users SET principal_kind=CASE WHEN u.is_tenant_ops THEN 'OPERATIONS' ELSE 'VENDOR' END,person_id=NULL WHERE id=u.id;
        ELSE
            IF u.person_id IS NULL THEN
                IF u.employee_id IS NOT NULL THEN
                    u.person_id:=public.console_employee_person(p_org,u.employee_id);
                ELSE
                    SELECT jsonb_agg(jsonb_build_object('employee_id',e.id,'person_id',b.person_id) ORDER BY e.id)
                    INTO candidates FROM public.employees e JOIN public.employee_person_bindings b
                    ON b.org_id=e.org_id AND b.employee_id=e.id
                    WHERE e.org_id=p_org AND e.name=u.display_name;
                    IF candidates IS NOT NULL THEN
                        INSERT INTO public.person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence)
                        VALUES(p_org,'ACCOUNT',u.id,'EMPLOYEE_LINK_MISSING',jsonb_build_object('candidates',candidates))
                        ON CONFLICT DO NOTHING;
                    END IF;
                    u.person_id:=u.id;
                    INSERT INTO public.persons(org_id,id) VALUES(p_org,u.person_id) ON CONFLICT DO NOTHING;
                END IF;
                UPDATE public.users SET person_id=u.person_id WHERE id=u.id;
            END IF;
            IF public.console_person_facts(p_org,u.person_id) IS NULL THEN
                PERFORM public.console_revise_person_facts(p_org,u.person_id,jsonb_build_object('legal_name',u.display_name,'phone',u.phone),NULL);
            END IF;
        END IF;
    END LOOP;
    PERFORM set_config('app.include_voided',coalesce(include_voided,''),true);
END $$;

-- Migration execution arms one tenant at a time and does not manufacture a requester.
DO $$ DECLARE o RECORD; previous TEXT:=current_setting('app.current_org',true); BEGIN
    FOR o IN SELECT id FROM organizations ORDER BY id LOOP
        PERFORM set_config('app.current_org',o.id::TEXT,true);
        PERFORM console_backfill_person_bindings(o.id);
    END LOOP;
    PERFORM set_config('app.current_org',coalesce(previous,''),true);
END $$;
ALTER TABLE users VALIDATE CONSTRAINT users_person_fk;
ALTER TABLE users VALIDATE CONSTRAINT users_principal_person_check;

-- Invoker views preserve RLS and keep all sensitive columns out of directory projections.
DO $$ DECLARE cols TEXT; BEGIN
    SELECT string_agg(CASE a.attname
        WHEN 'display_name' THEN 'CASE WHEN u.person_id IS NULL THEN u.display_name ELSE coalesce(f.attributes->>''display_name'',f.attributes->>''legal_name'',u.display_name) END AS display_name'
        WHEN 'phone' THEN 'CASE WHEN u.person_id IS NULL THEN u.phone ELSE f.attributes->>''phone'' END AS phone'
        ELSE 'u.'||quote_ident(a.attname) END,',' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a WHERE a.attrelid='users'::regclass AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE 'CREATE VIEW person_accounts_current WITH (security_invoker=true) AS SELECT '||cols||
        ' FROM public.users u LEFT JOIN LATERAL (SELECT r.attributes FROM public.person_revisions r WHERE r.org_id=u.org_id AND r.person_id=u.person_id ORDER BY r.version DESC LIMIT 1) f ON true';
END $$;
GRANT SELECT ON person_accounts_current TO console_rt;

-- The import definer writes employees in the SAME transaction as this binding.
GRANT SELECT,INSERT ON persons,person_revisions,employee_person_bindings,person_binding_reviews TO console_leave_definer;
GRANT SELECT ON employee_employment_profiles TO console_leave_definer;
GRANT UPDATE(person_id) ON users TO console_leave_definer;
REVOKE ALL ON FUNCTION console_revise_person_facts(UUID,UUID,JSONB,UUID),console_bind_employee_person(UUID,UUID,UUID),console_backfill_person_bindings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_revise_person_facts(UUID,UUID,JSONB,UUID),console_bind_employee_person(UUID,UUID,UUID),console_backfill_person_bindings(UUID) TO console_rt,console_leave_definer;

CREATE OR REPLACE FUNCTION platform_list_group_accounts(p_group_id UUID)
RETURNS TABLE (
    user_id UUID,
    display_name TEXT,
    phone TEXT,
    tenant_roles TEXT[],
    is_active BOOLEAN,
    has_passkey BOOLEAN,
    account_status TEXT,
    org_id UUID,
    org_slug TEXT,
    org_name TEXT,
    group_roles TEXT[],
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    SET LOCAL row_security = off;

    RETURN QUERY
        SELECT
            u.id AS user_id,
            u.display_name,
            u.phone,
            u.roles AS tenant_roles,
            u.is_active,
            EXISTS (
                SELECT 1
                FROM auth_webauthn_credentials c
                WHERE c.user_id = u.id
            ) AS has_passkey,
            CASE
                WHEN NOT u.is_active THEN 'DEACTIVATED'
                WHEN EXISTS (
                    SELECT 1
                    FROM auth_webauthn_credentials c
                    WHERE c.user_id = u.id
                ) THEN 'ACTIVE'
                ELSE 'PENDING_SETUP'
            END AS account_status,
            o.id AS org_id,
            o.slug AS org_slug,
            o.name AS org_name,
            array_agg(gr.group_role ORDER BY gr.group_role) AS group_roles,
            u.created_at
        FROM group_role_grants gr
        JOIN group_memberships gm
          ON gm.group_id = gr.group_id
        JOIN person_accounts_current u
          ON u.id = gr.user_id
         AND u.org_id = gm.org_id
        JOIN organizations o
          ON o.id = u.org_id
         AND o.id <> '00000000-0000-0000-0000-00000000face'::uuid
        WHERE gr.group_id = p_group_id
        GROUP BY
            u.id,
            u.display_name,
            u.phone,
            u.roles,
            u.is_active,
            o.id,
            o.slug,
            o.name,
            u.created_at
        ORDER BY o.name ASC, u.display_name ASC, u.id ASC;

    SET LOCAL row_security = on;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;
REVOKE ALL ON FUNCTION platform_list_group_accounts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_group_accounts(UUID) TO console_rt;

CREATE OR REPLACE FUNCTION inherit_command_audit_context() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE ctx JSONB; phase TEXT; parents UUID[]; versions JSONB; scopes UUID[];
BEGIN
    ctx:=NULLIF(current_setting('app.audit_command',true),'')::JSONB;
    IF ctx IS NULL OR NEW.source IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW.org_id IS DISTINCT FROM (ctx->>'org_id')::UUID THEN
        RAISE EXCEPTION 'audit tenant does not match transaction' USING ERRCODE='42501';
    END IF;
    SELECT COALESCE(array_agg(value::UUID),'{}'::UUID[]) INTO scopes FROM jsonb_array_elements_text(ctx->'scope_ids');
    scopes:=array_append(scopes,NEW.org_id);
    IF NEW.branch_id IS NOT NULL THEN scopes:=array_append(scopes,NEW.branch_id); END IF;
    SELECT a.phase,a.parent_scopes,a.versions INTO phase,parents,versions FROM audit_admission_snapshot(NEW.org_id,scopes) a;
    NEW.source:=ctx->>'source';
    NEW.change_mode:=COALESCE(ctx->>'change_mode',CASE WHEN phase='SETUP' THEN 'SETUP' ELSE 'DIRECT' END);
    NEW.reason_code:=COALESCE(ctx->>'reason_code',NEW.after_snap->>'reason_code');
    NEW.decision_snapshot:=COALESCE(ctx->'decision_snapshot','{}'::JSONB)||versions;
    NEW.command_id:=(ctx->>'command_id')::UUID;
    SELECT array_agg(DISTINCT value ORDER BY value) INTO NEW.scope_ids FROM unnest(scopes||parents) value;
    NEW.actor_kind:=ctx->>'actor_kind';
    NEW.principal_type:=CASE WHEN NEW.actor_kind='OPS_ACCOUNT' THEN 'TENANT_USER' ELSE NEW.actor_kind END;
    NEW.session_id:=(ctx->>'session_id')::UUID;
    NEW.outcome:=CASE WHEN NEW.action ~ '(\.refused$|_refused$|\.denied$)' THEN 'DENIED' ELSE COALESCE(ctx->>'outcome','ALLOWED') END;
    SELECT display_name INTO NEW.actor_display FROM person_accounts_current WHERE org_id=NEW.org_id AND id=NEW.actor;
    NEW.actor_employer:=ctx->>'actor_employer';
    NEW.row_hash_version:=2;
    RETURN NEW;
END $$;

DO $$ DECLARE cols TEXT; BEGIN
    SELECT string_agg(CASE a.attname
        WHEN 'name' THEN 'coalesce(f.attributes->>''legal_name'',e.name) AS name'
        WHEN 'birth_date' THEN 'CASE WHEN f.attributes ? ''birth_date'' THEN (f.attributes->>''birth_date'')::DATE ELSE e.birth_date END AS birth_date'
        ELSE 'e.'||quote_ident(a.attname) END,',' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a WHERE a.attrelid='employees'::regclass AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE 'CREATE VIEW person_employees_current WITH (security_invoker=true) AS SELECT '||cols||
        ' FROM public.employees e LEFT JOIN public.employee_person_bindings b ON b.org_id=e.org_id AND b.employee_id=e.id LEFT JOIN LATERAL (SELECT r.attributes FROM public.person_revisions r WHERE r.org_id=b.org_id AND r.person_id=b.person_id ORDER BY r.version DESC LIMIT 1) f ON true';
END $$;
GRANT SELECT ON person_employees_current TO console_rt,console_leave_definer;

-- N-1 keeps its released signature; the current binary also returns the binding.
CREATE FUNCTION platform_list_group_person_accounts(p_group_id UUID)
RETURNS TABLE(user_id UUID,person_id UUID,principal_kind TEXT,display_name TEXT,phone TEXT,
    tenant_roles TEXT[],is_active BOOLEAN,has_passkey BOOLEAN,account_status TEXT,
    org_id UUID,org_slug TEXT,org_name TEXT,group_roles TEXT[],created_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog SET row_security=off AS $$
    SELECT a.user_id,u.person_id,u.principal_kind,a.display_name,a.phone,a.tenant_roles,
        a.is_active,a.has_passkey,a.account_status,a.org_id,a.org_slug,a.org_name,a.group_roles,a.created_at
    FROM public.platform_list_group_accounts(p_group_id) a
    JOIN public.users u ON u.id=a.user_id AND u.org_id=a.org_id
    ORDER BY a.org_name,a.display_name,a.user_id
$$;
REVOKE ALL ON FUNCTION platform_list_group_person_accounts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_group_person_accounts(UUID) TO console_rt;

CREATE OR REPLACE FUNCTION employee_void_destroy_pii(p_employee UUID, p_release_number BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org UUID := NULLIF(current_setting('app.current_org', true), '')::uuid;
BEGIN
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'employee tombstone needs an armed tenant';
    END IF;
    PERFORM set_config('app.include_voided', 'on', true);
    PERFORM 1 FROM employees
      WHERE org_id = v_org AND id = p_employee
        AND employment_status = 'VOIDED' AND pii_destroyed_at IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee tombstone refused: % is not a void record with personal data', p_employee;
    END IF;

    PERFORM set_config('app.pii_destruction','on',true);
    UPDATE employees SET
        name = '(파기됨)', org_unit = NULL, job = NULL, position = NULL,
        worksite_name = NULL, worksite_address = NULL, birth_date = NULL,
        work_email = NULL, id_type = NULL, raw_row = '{}'::jsonb,
        employee_number = CASE WHEN p_release_number THEN NULL ELSE employee_number END,
        -- A console registration's source_key is 'console:' || 사번 (0183).
        source_key = CASE WHEN p_release_number THEN 'voided:' || id::text ELSE source_key END,
        pii_destroyed_at = now(), updated_at = now()
     WHERE org_id = v_org AND id = p_employee;
    UPDATE employee_employment_profiles SET
        phone_e164 = NULL, base_pay = NULL, base_pay_won = NULL, pay_unit = NULL,
        contract_start_date = NULL, contract_end_date = NULL, probation_end_date = NULL
     WHERE org_id = v_org AND employee_id = p_employee;
    UPDATE employee_corrections SET old_value = NULL, new_value = 'null'::jsonb
     WHERE org_id = v_org AND employee_id = p_employee;

    -- The person's history, unless another live record names the same person.
    PERFORM set_config('app.pii_destruction', 'on', true);
    UPDATE person_revisions r SET attributes = '{}'::jsonb, receipt = '{}'::jsonb
      FROM employee_person_bindings b
     WHERE b.org_id = v_org AND b.employee_id = p_employee
       AND r.org_id = v_org AND r.person_id = b.person_id
       AND NOT EXISTS (
           SELECT 1 FROM employee_person_bindings o
             JOIN employees e ON e.org_id = o.org_id AND e.id = o.employee_id
            WHERE o.org_id = v_org AND o.person_id = b.person_id
              AND o.employee_id <> p_employee AND e.voided_at IS NULL);
    -- Canonical erasure also clears the retained account snapshots and review evidence.
    UPDATE users u SET display_name=e.name,phone=NULL FROM employees e
    WHERE e.org_id=v_org AND e.id=p_employee AND u.org_id=v_org
      AND u.person_id=console_employee_person(v_org,p_employee)
      AND NOT EXISTS(SELECT 1 FROM employee_person_bindings b JOIN employees other
          ON other.org_id=b.org_id AND other.id=b.employee_id
          WHERE b.org_id=v_org AND b.person_id=u.person_id AND other.voided_at IS NULL);
    DELETE FROM person_binding_reviews r WHERE r.org_id=v_org AND
      ((r.subject_kind='EMPLOYEE' AND r.subject_id=p_employee)
       OR (r.subject_kind='ACCOUNT' AND EXISTS(SELECT 1 FROM users u WHERE u.org_id=v_org AND u.id=r.subject_id
           AND u.person_id=console_employee_person(v_org,p_employee))));
    UPDATE person_binding_reviews r SET evidence=jsonb_set(r.evidence,'{candidates}',
        (SELECT jsonb_agg(CASE WHEN c->>'employee_id'=p_employee::TEXT THEN c-'birth_date' ELSE c END)
         FROM jsonb_array_elements(r.evidence->'candidates') c))
    WHERE r.org_id=v_org AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence->'candidates') c WHERE c->>'employee_id'=p_employee::TEXT);
    IF console_employee_person(v_org,p_employee) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM employee_person_bindings b JOIN employees other
        ON other.org_id=b.org_id AND other.id=b.employee_id
        WHERE b.org_id=v_org AND b.person_id=console_employee_person(v_org,p_employee) AND other.voided_at IS NULL) THEN
        PERFORM console_revise_person_facts(v_org,console_employee_person(v_org,p_employee),
            (SELECT jsonb_build_object('display_name',e.name,'phone',NULL,'birth_date',NULL)
             FROM employees e WHERE e.org_id=v_org AND e.id=p_employee),NULL);
    END IF;
    PERFORM set_config('app.pii_destruction', 'off', true);
    PERFORM set_config('app.include_voided', 'off', true);
END $$;

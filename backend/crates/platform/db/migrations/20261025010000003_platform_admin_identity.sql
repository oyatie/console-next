-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: identity is the platform sentinel + SUPER_ADMIN; names stay editable.
SET LOCAL lock_timeout = '2s';
-- Keep NOT NULL and every existing name until the N+1 contract migration.
ALTER TABLE users ADD CONSTRAINT users_display_name_nonblank
    CHECK (btrim(display_name) <> '') NOT VALID;

CREATE OR REPLACE FUNCTION public.platform_ensure_cold_start_admin() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    platform_id CONSTANT UUID := '00000000-0000-0000-0000-00000000face';
    admin_id UUID;
    admin_login TEXT;
BEGIN
    SET LOCAL row_security = off;

    -- Serialize empty-database boots before looking up the stable platform identity.
    PERFORM pg_advisory_xact_lock(hashtext('platform_ensure_cold_start_admin'));
    SELECT id INTO admin_id
    FROM users
    WHERE org_id = platform_id
      AND roles @> ARRAY['SUPER_ADMIN']::TEXT[]
    ORDER BY id
    LIMIT 1;

    IF admin_id IS NULL THEN
        -- Matches 0036: the sentinel is ARCHIVED so it can never be mistaken for a tenant.
        INSERT INTO organizations (id, slug, name, status)
        VALUES (platform_id, 'platform', 'Platform (vendor tier)', 'ARCHIVED')
        ON CONFLICT (id) DO NOTHING;

        PERFORM set_config('app.current_org', platform_id::text, true);
        -- N-1 requires a name: a new root uses its real sign-in identifier, not a seeded person name.
        admin_id := gen_random_uuid();
        admin_login := sign_in_id_default(platform_id, admin_id);
        INSERT INTO users (id, display_name, roles, is_active, org_id)
        SELECT admin_id, admin_login || '@' || slug, ARRAY['SUPER_ADMIN']::TEXT[], true, platform_id
        FROM organizations WHERE id = platform_id;
        INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code)
        VALUES (platform_id, admin_login, admin_id, (now() AT TIME ZONE 'Asia/Seoul')::date, 'SYSTEM_DEFAULT');
    END IF;

    SET LOCAL row_security = on;
    RETURN admin_id;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_ensure_cold_start_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_ensure_cold_start_admin() TO console_rt;

-- An unnamed account has no actor-name snapshot, while its stable actor id remains recorded.
CREATE OR REPLACE FUNCTION inherit_command_audit_context() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE ctx JSONB; phase TEXT; parents UUID[]; versions JSONB; scopes UUID[];
BEGIN
    NEW.actor_display:=NULLIF(btrim(NEW.actor_display),'');
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
    SELECT NULLIF(btrim(display_name),'') INTO NEW.actor_display FROM person_accounts_current WHERE org_id=NEW.org_id AND id=NEW.actor;
    NEW.actor_employer:=ctx->>'actor_employer';
    NEW.row_hash_version:=2;
    RETURN NEW;
END $$;

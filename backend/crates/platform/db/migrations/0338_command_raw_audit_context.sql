-- Expand: isolated SQL command functions inherit trusted request facts in their own transaction.
SET LOCAL lock_timeout = '2s';
CREATE FUNCTION inherit_command_audit_context() RETURNS trigger LANGUAGE plpgsql
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
    SELECT display_name INTO NEW.actor_display FROM users WHERE org_id=NEW.org_id AND id=NEW.actor;
    NEW.actor_employer:=ctx->>'actor_employer';
    NEW.row_hash_version:=2;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION inherit_command_audit_context() FROM PUBLIC;
CREATE TRIGGER trg_inherit_command_audit_context BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION inherit_command_audit_context();
CREATE OR REPLACE FUNCTION emit_command_outcome() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.state<>'PROCESSING' AND (
        OLD.state IS DISTINCT FROM NEW.state OR OLD.result IS DISTINCT FROM NEW.result
        OR OLD.touched IS DISTINCT FROM NEW.touched
        OR (OLD.execution_token IS NOT NULL AND NEW.execution_token IS NULL)
    ) THEN
        INSERT INTO resource_changes(org_id,audit_event_id,resource_type,resource_id)
        VALUES(NEW.org_id,NEW.id,'command_outcome',NULL);
        PERFORM pg_notify('resource_changed',json_build_object('org',NEW.org_id,'tx',pg_current_xact_id()::TEXT)::TEXT);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emit_command_outcome() FROM PUBLIC,console_rt;
-- Rollback: old binaries ignore the new context GUC and keep writing v1 rows.

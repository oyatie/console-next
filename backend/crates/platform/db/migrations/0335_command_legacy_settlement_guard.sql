-- Fail closed for legacy terminal rows without transaction metadata.
SET LOCAL lock_timeout = '2s';
CREATE OR REPLACE FUNCTION settle_audited_command() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE command_state TEXT; command_tx TEXT;
BEGIN
    IF NEW.command_id IS NULL OR COALESCE(NEW.outcome,'ALLOWED') <> 'ALLOWED'
       OR NEW.action IN ('command.received','command.refused','command.expired')
       OR NEW.action ~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)' THEN RETURN NEW; END IF;
    SELECT state,settled_transaction INTO command_state,command_tx FROM command_outcomes WHERE org_id=NEW.org_id AND id=NEW.command_id FOR UPDATE;
    IF command_state IS NULL THEN RETURN NEW; END IF;
    IF command_state <> 'PROCESSING' AND (command_state <> 'APPLIED' OR command_tx IS DISTINCT FROM pg_current_xact_id()::text) THEN RAISE EXCEPTION 'command has already settled'; END IF;
    UPDATE command_outcomes c SET state='APPLIED',settled_at=now(),touched=(
        SELECT COALESCE(jsonb_agg(jsonb_build_object('type',e.target_type,'id',e.target_id,
            'audit_id',e.id,'branch_id',e.branch_id) ORDER BY e.created_at,e.id),'[]')
        FROM audit_events e WHERE e.org_id=NEW.org_id AND e.command_id=NEW.command_id
          AND e.outcome='ALLOWED' AND e.action NOT IN ('command.received','command.refused','command.expired')
          AND e.action !~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)'
    ) WHERE c.org_id=NEW.org_id AND c.id=NEW.command_id AND c.state='PROCESSING';
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION settle_audited_command() FROM PUBLIC,console_rt;

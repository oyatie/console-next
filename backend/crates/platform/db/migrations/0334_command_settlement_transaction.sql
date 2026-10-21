-- Permit wrapper settlement plus deferred audit within one transaction only.
SET LOCAL lock_timeout = '2s';
ALTER TABLE command_outcomes ADD COLUMN settled_transaction TEXT;
COMMENT ON COLUMN command_outcomes.settled_transaction IS 'pd:none — terminal transaction identity; never returned';
CREATE FUNCTION capture_command_settlement_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state='PROCESSING' AND NEW.state <> 'PROCESSING' THEN
        NEW.settled_transaction := pg_current_xact_id()::text;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_command_settlement_transaction BEFORE UPDATE ON command_outcomes
FOR EACH ROW EXECUTE FUNCTION capture_command_settlement_transaction();
REVOKE ALL ON FUNCTION capture_command_settlement_transaction() FROM PUBLIC,console_rt;
CREATE OR REPLACE FUNCTION settle_audited_command() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE command_state TEXT; command_tx TEXT;
BEGIN
    IF NEW.command_id IS NULL OR COALESCE(NEW.outcome,'ALLOWED') <> 'ALLOWED'
       OR NEW.action IN ('command.received','command.refused','command.expired')
       OR NEW.action ~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)' THEN RETURN NEW; END IF;
    SELECT state,settled_transaction INTO command_state,command_tx FROM command_outcomes WHERE org_id=NEW.org_id AND id=NEW.command_id FOR UPDATE;
    IF command_state IS NULL THEN RETURN NEW; END IF;
    IF command_state <> 'PROCESSING' AND NOT (command_state='APPLIED' AND command_tx=pg_current_xact_id()::text) THEN RAISE EXCEPTION 'command has already settled'; END IF;
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

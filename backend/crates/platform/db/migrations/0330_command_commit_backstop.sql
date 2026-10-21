-- Raw audited transaction callers settle at commit, just like with_audit.
SET LOCAL lock_timeout = '2s';
CREATE FUNCTION settle_audited_command() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.command_id IS NULL OR COALESCE(NEW.outcome,'ALLOWED') <> 'ALLOWED'
       OR NEW.action IN ('command.received','command.refused')
       OR NEW.action ~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)' THEN
        RETURN NEW;
    END IF;
    UPDATE command_outcomes c SET state='APPLIED',settled_at=now(),touched=(
        SELECT COALESCE(jsonb_agg(jsonb_build_object('type',e.target_type,'id',e.target_id,
            'audit_id',e.id,'branch_id',e.branch_id) ORDER BY e.created_at,e.id),'[]')
        FROM audit_events e WHERE e.org_id=NEW.org_id AND e.command_id=NEW.command_id
          AND e.outcome='ALLOWED' AND e.action NOT IN ('command.received','command.refused')
          AND e.action !~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)'
    ) WHERE c.org_id=NEW.org_id AND c.id=NEW.command_id AND c.state='PROCESSING';
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION settle_audited_command() FROM PUBLIC,console_rt;
CREATE CONSTRAINT TRIGGER trg_audit_settle_command AFTER INSERT ON audit_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION settle_audited_command();

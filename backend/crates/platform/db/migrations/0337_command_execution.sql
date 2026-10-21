-- Expand: one admitted HTTP execution may contain independently committed steps.
SET LOCAL lock_timeout = '2s';
ALTER TABLE command_outcomes ADD COLUMN execution_token UUID;
ALTER TABLE command_outcomes ADD COLUMN response_status SMALLINT;
ALTER TABLE command_outcomes ADD COLUMN last_execution_transaction TEXT;
COMMENT ON COLUMN command_outcomes.last_execution_transaction IS 'pd:none — audit projection transaction marker; never returned';
ALTER TABLE command_outcomes ADD CONSTRAINT command_response_status CHECK (response_status BETWEEN 200 AND 299);
COMMENT ON COLUMN command_outcomes.execution_token IS 'pd:none — private active execution capability; never returned';
COMMENT ON COLUMN command_outcomes.response_status IS 'pd:none — successful replay HTTP status';
GRANT UPDATE(execution_token,response_status) ON command_outcomes TO console_rt;
ALTER TABLE command_outcomes DROP CONSTRAINT command_outcomes_org_id_actor_id_idempotency_key_key;
ALTER TABLE command_outcomes ADD UNIQUE(org_id,actor_id,command,idempotency_key);
CREATE OR REPLACE FUNCTION command_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.org_id, NEW.actor_id, NEW.idempotency_key, NEW.command, NEW.request_fingerprint, NEW.inputs_masked, NEW.created_at, NEW.retain_until)
       IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.actor_id, OLD.idempotency_key, OLD.command, OLD.request_fingerprint, OLD.inputs_masked, OLD.created_at, OLD.retain_until) THEN
        RAISE EXCEPTION 'command identity is immutable';
    END IF;
    -- Employee creation already has a payload-bound durable key; its isolated
    -- routing command may resume only the missing first branch, never creation.
    IF OLD.state='APPLIED' AND OLD.execution_token IS NULL AND NEW.execution_token IS NOT NULL
       AND NEW.execution_token::TEXT=NULLIF(current_setting('app.command_execution',true),'')
       AND OLD.command='POST /api/v1/employees' AND OLD.result IS NULL AND OLD.response_status IS NULL
       AND (to_jsonb(NEW)-'execution_token')=(to_jsonb(OLD)-'execution_token')
       AND EXISTS (SELECT 1 FROM audit_events e JOIN employees p ON p.org_id=e.org_id AND p.id::TEXT=e.target_id
           WHERE e.org_id=OLD.org_id AND e.command_id=OLD.id AND e.actor=OLD.actor_id
             AND e.action='employee.create' AND p.home_branch_id IS NULL) THEN RETURN NEW; END IF;
    IF OLD.state <> 'PROCESSING' AND NEW IS DISTINCT FROM OLD AND NOT (
        OLD.state='APPLIED' AND NEW.state='APPLIED' AND OLD.execution_token IS NOT NULL
        AND OLD.execution_token::TEXT=NULLIF(current_setting('app.command_execution',true),'')
        AND (NEW.execution_token IS NULL OR NEW.execution_token=OLD.execution_token)
        AND NEW.deadline IS NOT DISTINCT FROM OLD.deadline
        AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at
        AND NEW.settled_transaction IS NOT DISTINCT FROM OLD.settled_transaction
        AND NEW.refusal_code IS NOT DISTINCT FROM OLD.refusal_code
        AND (NEW.last_execution_transaction IS NOT DISTINCT FROM OLD.last_execution_transaction OR NEW.last_execution_transaction=pg_current_xact_id()::TEXT)
    ) THEN RAISE EXCEPTION 'settled command outcome is immutable'; END IF;
    RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION settle_audited_command() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE command_state TEXT; command_tx TEXT; token UUID; expires TIMESTAMPTZ; projected_tx TEXT;
BEGIN
    IF NEW.command_id IS NULL OR COALESCE(NEW.outcome,'ALLOWED') <> 'ALLOWED'
       OR NEW.action IN ('command.received','command.refused','command.expired')
       OR NEW.action ~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)' THEN RETURN NEW; END IF;
    SELECT state,settled_transaction,execution_token,deadline,last_execution_transaction INTO command_state,command_tx,token,expires,projected_tx
      FROM command_outcomes WHERE org_id=NEW.org_id AND id=NEW.command_id FOR UPDATE;
    IF command_state IS NULL THEN RETURN NEW; END IF;
    IF command_state NOT IN ('PROCESSING','APPLIED') OR expires<=clock_timestamp()
       OR token::TEXT IS DISTINCT FROM NULLIF(current_setting('app.command_execution',true),'')
       OR (command_state='APPLIED' AND token IS NULL AND command_tx IS DISTINCT FROM pg_current_xact_id()::TEXT)
    THEN RAISE EXCEPTION 'command has already settled'; END IF;
    IF projected_tx=pg_current_xact_id()::TEXT THEN RETURN NEW; END IF;
    UPDATE command_outcomes c SET state='APPLIED',last_execution_transaction=pg_current_xact_id()::TEXT,settled_at=COALESCE(c.settled_at,now()),touched=(
        SELECT COALESCE(jsonb_agg(jsonb_build_object('type',e.target_type,'id',e.target_id,
            'audit_id',e.id,'branch_id',e.branch_id) ORDER BY e.created_at,e.id),'[]')
        FROM audit_events e WHERE e.org_id=NEW.org_id AND e.command_id=NEW.command_id
          AND e.outcome='ALLOWED' AND e.action NOT IN ('command.received','command.refused','command.expired')
          AND e.action !~ '(\.read$|_read$|\.refused$|_refused$|\.denied$|step_up)'
    ) WHERE c.org_id=NEW.org_id AND c.id=NEW.command_id AND (c.state='PROCESSING' OR token IS NOT NULL);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION settle_audited_command() FROM PUBLIC,console_rt;
-- Rollback to the released base, which has no command_outcomes reader, keeps
-- this schema. Intermediate lane binaries using the old conflict key do not.

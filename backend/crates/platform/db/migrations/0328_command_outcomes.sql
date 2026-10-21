-- BL-010. Registration exposes PROCESSING; APPLIED is settled inside the
-- mutation transaction. Refusals settle only after its rollback. Expand only.
SET LOCAL lock_timeout = '2s';
CREATE TABLE command_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    command TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (state IN ('PROCESSING','APPLIED','REFUSED','CONFLICT','CANCELLED','EXPIRED')),
    deadline TIMESTAMPTZ,
    inputs_masked JSONB NOT NULL DEFAULT '{}',
    result JSONB,
    touched JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(touched) = 'array'),
    refusal_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    retain_until TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 year',
    UNIQUE (org_id, actor_id, idempotency_key),
    CHECK ((state = 'PROCESSING') = (settled_at IS NULL))
);
ALTER TABLE command_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON command_outcomes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);
REVOKE ALL ON command_outcomes FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE (state, deadline, result, touched, refusal_code, settled_at) ON command_outcomes TO console_rt;
CREATE TRIGGER trg_command_outcomes_org_immutable BEFORE UPDATE ON command_outcomes FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE FUNCTION command_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.org_id, NEW.actor_id, NEW.idempotency_key, NEW.command, NEW.request_fingerprint, NEW.inputs_masked, NEW.created_at, NEW.retain_until)
       IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.actor_id, OLD.idempotency_key, OLD.command, OLD.request_fingerprint, OLD.inputs_masked, OLD.created_at, OLD.retain_until) THEN
        RAISE EXCEPTION 'command identity is immutable';
    END IF;
    IF OLD.state <> 'PROCESSING' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'settled command outcome is immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_command_outcome_immutable BEFORE UPDATE ON command_outcomes FOR EACH ROW EXECUTE FUNCTION command_outcome_immutable();
-- Value-free invalidation; no operation ID leaks to another account's stream.
CREATE FUNCTION emit_command_outcome() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.state <> 'PROCESSING' AND OLD.state IS DISTINCT FROM NEW.state THEN
        INSERT INTO resource_changes (org_id, audit_event_id, resource_type, resource_id)
        VALUES (NEW.org_id, NEW.id, 'command_outcome', NULL);
        PERFORM pg_notify('resource_changed', json_build_object('org', NEW.org_id, 'tx', pg_current_xact_id()::text)::text);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emit_command_outcome() FROM PUBLIC, console_rt;
CREATE CONSTRAINT TRIGGER trg_command_outcome_emit AFTER UPDATE ON command_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emit_command_outcome();
COMMENT ON TABLE command_outcomes IS 'Command outcome registry; minimum retention one year';
COMMENT ON COLUMN command_outcomes.id IS 'pd:none — opaque operation identifier';
COMMENT ON COLUMN command_outcomes.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN command_outcomes.actor_id IS 'pd:personal — authenticated submitting account';
COMMENT ON COLUMN command_outcomes.idempotency_key IS 'pd:none — opaque retry key';
COMMENT ON COLUMN command_outcomes.command IS 'pd:none — server endpoint discriminator';
COMMENT ON COLUMN command_outcomes.request_fingerprint IS 'pd:none — digest only';
COMMENT ON COLUMN command_outcomes.state IS 'pd:none — processing or terminal result';
COMMENT ON COLUMN command_outcomes.deadline IS 'pd:none — command-specific deadline';
COMMENT ON COLUMN command_outcomes.inputs_masked IS 'pd:none — input names only, values never retained';
COMMENT ON COLUMN command_outcomes.result IS 'pd:personal — authorized result, masked when record read is lost';
COMMENT ON COLUMN command_outcomes.touched IS 'pd:none — record and audit references';
COMMENT ON COLUMN command_outcomes.refusal_code IS 'pd:none — stable refusal';
COMMENT ON COLUMN command_outcomes.created_at IS 'pd:none — registration time';
COMMENT ON COLUMN command_outcomes.settled_at IS 'pd:none — settlement time';
COMMENT ON COLUMN command_outcomes.retain_until IS 'pd:none — one-year minimum retention boundary';

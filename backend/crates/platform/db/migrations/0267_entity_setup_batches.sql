-- MR-29 (decisions #21): bulk 법인 · 사업장 create and update from a sheet.
--
-- entity_setup_batches: one row per applied batch (create / revise 법인 and
-- 사업장, in one transaction) and one per undo of one. `steps` holds, per
-- touched record, its id, whether the batch created it, the revision the
-- batch wrote and the version it left the record at, and the entity roles
-- (대표 / 본점 사업장) before and after, so an undo can refuse a record changed
-- since instead of reverting blindly (onboarding-and-migration §5.4). Ids,
-- versions and flags only: no names, no addresses, no personal data
-- (개인정보 보호법 §3 minimisation; the revisions keep the values).

CREATE TABLE entity_setup_batches (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    command_id UUID        NOT NULL,
    kind       TEXT        NOT NULL CHECK (kind IN ('APPLY', 'UNDO')),
    undoes     UUID        NULL,
    change_mode TEXT       NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER')),
    steps      JSONB       NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
    roles      JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(roles) = 'array'),
    undone_by  UUID        NULL,
    actor_id   UUID        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id),
    CONSTRAINT entity_setup_batches_undo CHECK ((kind = 'UNDO') = (undoes IS NOT NULL)),
    CONSTRAINT entity_setup_batches_undoable CHECK (kind = 'APPLY' OR undone_by IS NULL),
    FOREIGN KEY (org_id, undoes) REFERENCES entity_setup_batches (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, undone_by) REFERENCES entity_setup_batches (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX entity_setup_batches_recent_idx ON entity_setup_batches (org_id, created_at DESC);

-- Immutable except `undone_by`, which is set once.
CREATE FUNCTION entity_setup_batches_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'entity_setup_batches rows are kept (id=%)', OLD.id;
    END IF;
    IF (NEW.org_id, NEW.id, NEW.command_id, NEW.kind, NEW.undoes, NEW.change_mode, NEW.steps, NEW.roles,
        NEW.actor_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.org_id, OLD.id, OLD.command_id, OLD.kind, OLD.undoes, OLD.change_mode, OLD.steps, OLD.roles,
        OLD.actor_id, OLD.created_at)
       OR OLD.undone_by IS NOT NULL THEN
        RAISE EXCEPTION 'entity_setup_batches rows are immutable except setting undone_by once (id=%)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE entity_setup_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_setup_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON entity_setup_batches
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_entity_setup_batches_org_immutable BEFORE UPDATE ON entity_setup_batches
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_entity_setup_batches_guard BEFORE UPDATE OR DELETE ON entity_setup_batches
    FOR EACH ROW EXECUTE FUNCTION entity_setup_batches_guard();
REVOKE ALL PRIVILEGES ON entity_setup_batches FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON entity_setup_batches TO console_rt;
GRANT UPDATE (undone_by) ON entity_setup_batches TO console_rt;
COMMENT ON TABLE entity_setup_batches IS 'Bulk 법인 · 사업장 batches (sheet import) and their setup-phase undo, with per-record before/after pins (MR-29, decisions #21)';
COMMENT ON COLUMN entity_setup_batches.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN entity_setup_batches.id IS 'pd:none — batch id (the receipt the 되돌리기 action names)';
COMMENT ON COLUMN entity_setup_batches.command_id IS 'pd:none — the request Idempotency-Key';
COMMENT ON COLUMN entity_setup_batches.kind IS 'pd:none — APPLY | UNDO';
COMMENT ON COLUMN entity_setup_batches.undoes IS 'pd:none — for an UNDO, the batch it reverted';
COMMENT ON COLUMN entity_setup_batches.change_mode IS 'pd:none — SETUP (undoable) or GOVERNED (after 운영 시작)';
COMMENT ON COLUMN entity_setup_batches.steps IS 'pd:none — per record: op, target type and id, created flag, after revision id and version, needs_confirmation before';
COMMENT ON COLUMN entity_setup_batches.roles IS 'pd:none — per touched 법인: 대표 / 본점 사업장 ids before and after';
COMMENT ON COLUMN entity_setup_batches.undone_by IS 'pd:none — the UNDO batch that reverted this one; set once';
COMMENT ON COLUMN entity_setup_batches.actor_id IS 'pd:personal — user who ran the batch';
COMMENT ON COLUMN entity_setup_batches.created_at IS 'pd:none — row creation time';

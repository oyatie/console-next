-- MR-12 (decisions #18): one 부서 kind, and the setup-phase org batch
-- receipts that make every setup 부서 change undoable until 운영 시작.
-- Numbered head+1 of this lane's base (PA-ENT, 0261); INTEG renumbers it.
--
-- 1. ONE 부서 KIND. A 부서 sits in one 사업장 and nests to any depth (팀,
--    파트 are deeper 부서), so the canonical `team` kind is retired: every
--    unit whose current revision says `team` gets one more revision saying
--    `department`, with the rest of its attributes unchanged. Revisions are
--    append-only (0215 trigger), so the old `team` rows stay as history. The
--    actor of the new revision is the actor of the one it follows (the
--    revision FK needs a user; no change of substance is attributed to
--    anyone). Re-running finds no `team` heads, so this is idempotent.
--    Row security is off for the cross-tenant pass (0225, 0259 precedent).
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
    h      RECORD;
    v_attr JSONB;
BEGIN
    SET LOCAL row_security = off;
    FOR h IN
        SELECT DISTINCT ON (r.org_id, r.org_unit_id) r.org_id, r.org_unit_id, r.version, r.actor_id, r.attributes
        FROM org_unit_revisions r
        ORDER BY r.org_id, r.org_unit_id, r.version DESC
    LOOP
        CONTINUE WHEN h.attributes ->> 'kind' IS DISTINCT FROM 'team';
        v_attr := jsonb_set(h.attributes, '{kind}', '"department"');
        INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id,
            payload_digest, attributes, receipt)
        VALUES (h.org_id, h.org_unit_id, h.version + 1, gen_random_uuid(), h.actor_id,
            sha256(convert_to(v_attr::text, 'UTF8')), v_attr,
            jsonb_build_object('org_unit_id', h.org_unit_id::text, 'version', h.version + 1,
                               'target', 'revise', 'migration', 'org_unit_one_department_kind'));
    END LOOP;
END $$;

-- 2. org_setup_batches: one row per accepted setup org batch (create /
--    rename / move / dissolve 부서, in one transaction) and per undo of one.
--    `steps` holds, per touched unit, its before-image (NULL when the batch
--    created it) and the version the batch left it at, so an undo can refuse
--    a unit changed since instead of reverting blindly. Ids, versions and
--    unit attributes (names of 부서) only: no personal data.
CREATE TABLE org_setup_batches (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    command_id UUID        NOT NULL,
    kind       TEXT        NOT NULL CHECK (kind IN ('APPLY', 'UNDO')),
    undoes     UUID        NULL,
    steps      JSONB       NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
    undone_by  UUID        NULL,
    actor_id   UUID        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id),
    CONSTRAINT org_setup_batches_undo CHECK ((kind = 'UNDO') = (undoes IS NOT NULL)),
    CONSTRAINT org_setup_batches_undoable CHECK (kind = 'APPLY' OR undone_by IS NULL),
    FOREIGN KEY (org_id, undoes) REFERENCES org_setup_batches (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, undone_by) REFERENCES org_setup_batches (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX org_setup_batches_recent_idx ON org_setup_batches (org_id, created_at DESC);

-- Immutable except `undone_by`, which is set once.
CREATE FUNCTION org_setup_batches_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'org_setup_batches rows are kept (id=%)', OLD.id;
    END IF;
    IF (NEW.org_id, NEW.id, NEW.command_id, NEW.kind, NEW.undoes, NEW.steps, NEW.actor_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.org_id, OLD.id, OLD.command_id, OLD.kind, OLD.undoes, OLD.steps, OLD.actor_id, OLD.created_at)
       OR OLD.undone_by IS NOT NULL THEN
        RAISE EXCEPTION 'org_setup_batches rows are immutable except setting undone_by once (id=%)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE org_setup_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_setup_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org_setup_batches
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_org_setup_batches_org_immutable BEFORE UPDATE ON org_setup_batches
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_org_setup_batches_guard BEFORE UPDATE OR DELETE ON org_setup_batches
    FOR EACH ROW EXECUTE FUNCTION org_setup_batches_guard();
REVOKE ALL PRIVILEGES ON org_setup_batches FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON org_setup_batches TO console_rt;
GRANT UPDATE (undone_by) ON org_setup_batches TO console_rt;
COMMENT ON TABLE org_setup_batches IS 'Setup-phase 부서 batches and their undo, with per-unit before-images (decisions #18, #20)';
COMMENT ON COLUMN org_setup_batches.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN org_setup_batches.id IS 'pd:none — batch id (the receipt the 되돌리기 action names)';
COMMENT ON COLUMN org_setup_batches.command_id IS 'pd:none — the request Idempotency-Key';
COMMENT ON COLUMN org_setup_batches.kind IS 'pd:none — APPLY | UNDO';
COMMENT ON COLUMN org_setup_batches.undoes IS 'pd:none — for an UNDO, the batch it reverted';
COMMENT ON COLUMN org_setup_batches.steps IS 'pd:none — per unit: org_unit_id, before {version, attributes} or NULL, after_version';
COMMENT ON COLUMN org_setup_batches.undone_by IS 'pd:none — the UNDO batch that reverted this one; set once';
COMMENT ON COLUMN org_setup_batches.actor_id IS 'pd:personal — user who ran the batch';
COMMENT ON COLUMN org_setup_batches.created_at IS 'pd:none — row creation time';

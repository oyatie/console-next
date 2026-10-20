-- SEC-K1-c: Legal hold on 접속기록/audit_events:
-- While a hold is active for a tenant, no path deletes its audit rows (tenant force-remove included).
-- Expand-only migration.
SET LOCAL lock_timeout = '2s';

-- console-gate: audited-table audit_legal_holds
CREATE TABLE audit_legal_holds (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    status         TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
    reason         TEXT        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
    placed_by      UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
    placed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_by    UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
    released_at    TIMESTAMPTZ NULL,
    release_reason TEXT        NULL CHECK (release_reason IS NULL OR char_length(btrim(release_reason)) BETWEEN 1 AND 2000),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_legal_holds_status_release_check CHECK (
        (status = 'ACTIVE' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL)
        OR (status = 'RELEASED' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
    )
);

CREATE INDEX idx_audit_legal_holds_org_status ON audit_legal_holds (org_id, status);

ALTER TABLE audit_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_legal_holds FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_legal_holds_tenant_isolation ON audit_legal_holds
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

COMMENT ON TABLE audit_legal_holds IS 'pd:none — legal hold records for audit log preservation';
COMMENT ON COLUMN audit_legal_holds.id IS 'pd:none — hold record UUID';
COMMENT ON COLUMN audit_legal_holds.org_id IS 'pd:none — tenant organization UUID';
COMMENT ON COLUMN audit_legal_holds.status IS 'pd:none — hold status enum (ACTIVE | RELEASED)';
COMMENT ON COLUMN audit_legal_holds.reason IS 'pd:none — legal hold placement rationale';
COMMENT ON COLUMN audit_legal_holds.placed_by IS 'pd:none — user UUID placing hold';
COMMENT ON COLUMN audit_legal_holds.placed_at IS 'pd:none — placement timestamp';
COMMENT ON COLUMN audit_legal_holds.released_by IS 'pd:none — user UUID releasing hold';
COMMENT ON COLUMN audit_legal_holds.released_at IS 'pd:none — release timestamp';
COMMENT ON COLUMN audit_legal_holds.release_reason IS 'pd:none — release rationale';
COMMENT ON COLUMN audit_legal_holds.created_at IS 'pd:none — record creation timestamp';
COMMENT ON COLUMN audit_legal_holds.updated_at IS 'pd:none — record modification timestamp';

-- Guard against deleting active holds, and allow deleting released holds only during force-remove sweep
CREATE OR REPLACE FUNCTION audit_legal_holds_delete_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'ACTIVE' THEN
        RAISE EXCEPTION 'tenant % is under active legal hold: hold record deletion is forbidden', OLD.org_id
            USING ERRCODE = '55000',
                  CONSTRAINT = 'audit_legal_holds_active';
    END IF;

    IF current_setting('app.platform_force_remove_org', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'audit_legal_holds is append-only: DELETE is forbidden (row id=%)',
            OLD.id
            USING ERRCODE = '55000';
    END IF;

    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_audit_legal_holds_delete_guard
    BEFORE DELETE ON audit_legal_holds
    FOR EACH ROW EXECUTE FUNCTION audit_legal_holds_delete_guard();

-- Audit trigger: hold place and release are themselves audited into audit_events
CREATE OR REPLACE FUNCTION audit_legal_holds_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_events (
            actor, action, target_type, target_id, before_snap, after_snap,
            trace_id, span_id, occurred_at, org_id
        ) VALUES (
            NEW.placed_by,
            'audit.legal_hold.placed',
            'organizations',
            NEW.org_id::text,
            NULL,
            jsonb_build_object('hold_id', NEW.id, 'org_id', NEW.org_id, 'reason', NEW.reason, 'placed_at', NEW.placed_at),
            replace(gen_random_uuid()::text, '-', ''),
            left(replace(gen_random_uuid()::text, '-', ''), 16),
            NEW.placed_at,
            NEW.org_id
        );
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED' THEN
            INSERT INTO audit_events (
                actor, action, target_type, target_id, before_snap, after_snap,
                trace_id, span_id, occurred_at, org_id
            ) VALUES (
                NEW.released_by,
                'audit.legal_hold.released',
                'organizations',
                NEW.org_id::text,
                jsonb_build_object('hold_id', OLD.id, 'org_id', OLD.org_id, 'reason', OLD.reason, 'status', OLD.status),
                jsonb_build_object('hold_id', NEW.id, 'org_id', NEW.org_id, 'release_reason', NEW.release_reason, 'status', NEW.status, 'released_at', NEW.released_at),
                replace(gen_random_uuid()::text, '-', ''),
                left(replace(gen_random_uuid()::text, '-', ''), 16),
                COALESCE(NEW.released_at, now()),
                NEW.org_id
            );
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_audit_legal_holds_audit_log
    AFTER INSERT OR UPDATE ON audit_legal_holds
    FOR EACH ROW EXECUTE FUNCTION audit_legal_holds_audit_log();

-- Upgrade audit_events_immutable to fail closed when an active legal hold exists on the tenant
CREATE OR REPLACE FUNCTION audit_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- DELETE is never permitted under any circumstance.
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'audit_events is append-only: % is forbidden (row id=%)',
            TG_OP, OLD.id;
    END IF;

    -- UPDATE: permit the sanctioned tenant-removal re-home (only the reference
    -- columns change, only when the DEFINER-armed GUC is on). Content is frozen.
    IF current_setting('app.audit_rehome', true) = 'on'
        AND NEW.id          IS NOT DISTINCT FROM OLD.id
        AND NEW.action      IS NOT DISTINCT FROM OLD.action
        AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
        AND NEW.target_id   IS NOT DISTINCT FROM OLD.target_id
        AND NEW.before_snap IS NOT DISTINCT FROM OLD.before_snap
        AND NEW.after_snap  IS NOT DISTINCT FROM OLD.after_snap
        AND NEW.trace_id    IS NOT DISTINCT FROM OLD.trace_id
        AND NEW.span_id     IS NOT DISTINCT FROM OLD.span_id
        AND NEW.occurred_at IS NOT DISTINCT FROM OLD.occurred_at
        AND NEW.created_at  IS NOT DISTINCT FROM OLD.created_at
    THEN
        IF OLD.org_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM audit_legal_holds WHERE org_id = OLD.org_id AND status = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION 'tenant % is under active legal hold: audit_events modification is forbidden',
                OLD.org_id
                USING ERRCODE = '55000',
                      CONSTRAINT = 'audit_legal_holds_active';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'audit_events is append-only: % is forbidden (row id=%)',
        TG_OP, OLD.id;
END;
$$;

-- Helper functions for placing and releasing legal holds
CREATE OR REPLACE FUNCTION audit_legal_hold_place(
    p_org_id UUID,
    p_reason TEXT,
    p_actor UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO audit_legal_holds (org_id, reason, placed_by, placed_at)
    VALUES (p_org_id, p_reason, p_actor, now())
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION audit_legal_hold_release(
    p_hold_id UUID,
    p_reason TEXT,
    p_actor UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_updated INTEGER;
BEGIN
    UPDATE audit_legal_holds
    SET status = 'RELEASED',
        released_by = p_actor,
        released_at = now(),
        release_reason = p_reason,
        updated_at = now()
    WHERE id = p_hold_id
      AND status = 'ACTIVE';
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        UPDATE audit_legal_holds
        SET status = 'RELEASED',
            released_by = p_actor,
            released_at = now(),
            release_reason = p_reason,
            updated_at = now()
        WHERE org_id = p_hold_id
          AND status = 'ACTIVE';
        GET DIAGNOSTICS v_updated = ROW_COUNT;

        IF v_updated = 0 THEN
            RAISE EXCEPTION 'no active legal hold found for %', p_hold_id
                USING ERRCODE = 'P0002';
        END IF;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION audit_legal_hold_place(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_legal_hold_place(UUID, TEXT, UUID) TO console_rt, console_app;

REVOKE ALL ON FUNCTION audit_legal_hold_release(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_legal_hold_release(UUID, TEXT, UUID) TO console_rt, console_app;

REVOKE ALL ON audit_legal_holds FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON audit_legal_holds TO console_rt, console_app;
REVOKE DELETE ON audit_legal_holds FROM console_rt;

-- SPDX-License-Identifier: LicenseRef-Proprietary
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
    case_ref       TEXT        NOT NULL CHECK (char_length(btrim(case_ref)) BETWEEN 1 AND 200),
    basis          TEXT        NOT NULL CHECK (char_length(btrim(basis)) BETWEEN 1 AND 2000),
    placed_by      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    placed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_by    UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
    released_at    TIMESTAMPTZ NULL,
    release_reason TEXT        NULL CHECK (release_reason IS NULL OR char_length(btrim(release_reason)) BETWEEN 1 AND 2000),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_legal_holds_status_release_check CHECK (
        (status = 'ACTIVE' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL)
        OR (status = 'RELEASED' AND released_by IS NOT NULL AND released_at IS NOT NULL AND release_reason IS NOT NULL)
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
COMMENT ON COLUMN audit_legal_holds.case_ref IS 'pd:none — legal matter reference';
COMMENT ON COLUMN audit_legal_holds.basis IS 'pd:none — legal authority for preservation';
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

-- Only release metadata may change; the original preservation evidence stays frozen.
CREATE FUNCTION audit_legal_holds_update_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED'
        AND ROW(NEW.id, NEW.org_id, NEW.reason, NEW.case_ref, NEW.basis,
                NEW.placed_by, NEW.placed_at, NEW.created_at)
            IS NOT DISTINCT FROM
            ROW(OLD.id, OLD.org_id, OLD.reason, OLD.case_ref, OLD.basis,
                OLD.placed_by, OLD.placed_at, OLD.created_at)
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'legal holds may only transition from ACTIVE to RELEASED without changing placement evidence'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_audit_legal_holds_update_guard
    BEFORE UPDATE ON audit_legal_holds
    FOR EACH ROW EXECUTE FUNCTION audit_legal_holds_update_guard();

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

-- Commands share the dedicated platform-removal authority, never the tenant runtime pool.
CREATE FUNCTION audit_legal_hold_place(
    p_org_id UUID, p_case_ref TEXT, p_basis TEXT, p_reason TEXT,
    p_actor UUID, p_trace_id CHAR(32), p_span_id CHAR(16), p_occurred_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_hold audit_legal_holds%ROWTYPE;
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'legal hold placement requires an actor' USING ERRCODE = '22004';
    END IF;
    -- Serialize placement with tenant removal so a concurrent hold cannot be lost.
    PERFORM 1 FROM organizations WHERE id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'organization not found: %', p_org_id USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO audit_legal_holds (org_id, case_ref, basis, reason, placed_by, placed_at)
    VALUES (p_org_id, p_case_ref, p_basis, p_reason, p_actor, p_occurred_at)
    RETURNING * INTO v_hold;
    INSERT INTO audit_events (
        actor, action, target_type, target_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id
    ) VALUES (
        p_actor, 'audit.legal_hold.placed', 'organizations', p_org_id::text, NULL,
        jsonb_build_object('hold_id', v_hold.id, 'org_id', p_org_id,
            'case_ref', v_hold.case_ref, 'basis', v_hold.basis,
            'reason', v_hold.reason, 'placed_by', p_actor, 'placed_at', v_hold.placed_at),
        p_trace_id, p_span_id, p_occurred_at, p_org_id
    );
    RETURN v_hold.id;
END;
$$;

CREATE FUNCTION audit_legal_hold_release(
    p_hold_id UUID, p_reason TEXT, p_actor UUID,
    p_trace_id CHAR(32), p_span_id CHAR(16), p_occurred_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_hold audit_legal_holds%ROWTYPE;
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'legal hold release requires an actor' USING ERRCODE = '22004';
    END IF;
    UPDATE audit_legal_holds
    SET status = 'RELEASED', released_by = p_actor, released_at = p_occurred_at,
        release_reason = p_reason, updated_at = p_occurred_at
    WHERE id = p_hold_id AND status = 'ACTIVE'
    RETURNING * INTO v_hold;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no active legal hold found for %', p_hold_id USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO audit_events (
        actor, action, target_type, target_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id
    ) VALUES (
        p_actor, 'audit.legal_hold.released', 'organizations', v_hold.org_id::text,
        jsonb_build_object('hold_id', v_hold.id, 'org_id', v_hold.org_id, 'status', 'ACTIVE'),
        jsonb_build_object('hold_id', v_hold.id, 'org_id', v_hold.org_id,
            'release_reason', v_hold.release_reason, 'status', v_hold.status,
            'released_by', p_actor, 'released_at', v_hold.released_at),
        p_trace_id, p_span_id, p_occurred_at, v_hold.org_id
    );
END;
$$;

REVOKE ALL ON FUNCTION audit_legal_hold_place(UUID, TEXT, TEXT, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    FROM PUBLIC, console_rt, console_app;
GRANT EXECUTE ON FUNCTION audit_legal_hold_place(UUID, TEXT, TEXT, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    TO console_platform_force_cmd;
REVOKE ALL ON FUNCTION audit_legal_hold_release(UUID, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    FROM PUBLIC, console_rt, console_app;
GRANT EXECUTE ON FUNCTION audit_legal_hold_release(UUID, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    TO console_platform_force_cmd;

REVOKE ALL ON audit_legal_holds FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON audit_legal_holds FROM console_rt, console_app;
GRANT SELECT ON audit_legal_holds TO console_rt;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- SEC-K1-c: extend the existing legal-hold registry to preserve tenant audit logs.
SET LOCAL lock_timeout = '2s';

-- NULL evidence_object_id means the tenant's audit logs; object holds retain their existing semantics.
ALTER TABLE docs_evidence_legal_holds
    ALTER COLUMN evidence_object_id DROP NOT NULL,
    ADD COLUMN evidence_org_id UUID GENERATED ALWAYS AS
        (CASE WHEN evidence_object_id IS NOT NULL THEN org_id END) STORED,
    DROP CONSTRAINT docs_evidence_legal_holds_applied_by_org_id_fkey,
    DROP CONSTRAINT docs_evidence_legal_holds_released_by_org_id_fkey,
    ADD FOREIGN KEY (applied_by, evidence_org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    ADD FOREIGN KEY (released_by, evidence_org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    ADD FOREIGN KEY (applied_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD FOREIGN KEY (released_by) REFERENCES users(id) ON DELETE RESTRICT;
COMMENT ON COLUMN docs_evidence_legal_holds.evidence_org_id IS
    'pd:none — tenant constraint for object hold actors; platform actors may hold tenant audit logs';
COMMENT ON COLUMN docs_evidence_legal_holds.evidence_object_id IS
    'pd:none — evidence object UUID; NULL preserves tenant audit logs';

CREATE UNIQUE INDEX docs_evidence_legal_holds_active_audit_case_key
    ON docs_evidence_legal_holds (org_id, case_ref)
    WHERE evidence_object_id IS NULL AND status = 'ACTIVE';

-- Tenant document commands keep INSERT/UPDATE; tenant audit holds require the platform command role.
DROP POLICY org_isolation ON docs_evidence_legal_holds;
CREATE POLICY org_isolation ON docs_evidence_legal_holds
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid
                AND evidence_object_id IS NOT NULL);
-- Keep owner rights: SECURITY DEFINER commands and the removal sweep run as console_app.
REVOKE DELETE, TRUNCATE ON docs_evidence_legal_holds FROM console_rt;

CREATE OR REPLACE FUNCTION docs_evidence_legal_hold_release_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.evidence_object_id IS NULL AND current_user = 'console_rt' THEN
        RAISE EXCEPTION 'tenant audit holds require platform command authority' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'ACTIVE' THEN
            RAISE EXCEPTION 'tenant % is under active legal hold', OLD.org_id
                USING ERRCODE = '55000', CONSTRAINT = 'audit_legal_holds_active';
        END IF;
        IF current_setting('app.platform_force_remove_org', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'legal holds are append-only: DELETE is forbidden'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED'
        AND ROW(NEW.id, NEW.org_id, NEW.evidence_object_id, NEW.reason, NEW.case_ref,
                NEW.basis, NEW.applied_by, NEW.applied_at, NEW.audit_event_id)
            IS NOT DISTINCT FROM
            ROW(OLD.id, OLD.org_id, OLD.evidence_object_id, OLD.reason, OLD.case_ref,
                OLD.basis, OLD.applied_by, OLD.applied_at, OLD.audit_event_id)
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'legal holds may only release without changing placement evidence'
        USING ERRCODE = '55000';
END;
$$;
-- The shared guard also freezes org_id, with a consistent refusal code.
DROP TRIGGER trg_docs_evidence_legal_holds_org_immutable ON docs_evidence_legal_holds;

CREATE FUNCTION legal_holds_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'legal holds are append-only: TRUNCATE is forbidden'
        USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_legal_holds_no_truncate BEFORE TRUNCATE ON docs_evidence_legal_holds
    FOR EACH STATEMENT EXECUTE FUNCTION legal_holds_no_truncate();

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
            SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = OLD.org_id AND status = 'ACTIVE'
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
    v_hold docs_evidence_legal_holds%ROWTYPE;
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'legal hold placement requires an actor' USING ERRCODE = '22004';
    END IF;
    -- Serialize placement with tenant removal so a concurrent hold cannot be lost.
    IF platform_lock_organization_accounts_for_removal(p_org_id) IS NULL THEN
        RAISE EXCEPTION 'organization not found: %', p_org_id USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO docs_evidence_legal_holds (org_id, case_ref, basis, reason, applied_by, applied_at)
    VALUES (p_org_id, p_case_ref, p_basis, p_reason, p_actor, p_occurred_at)
    RETURNING * INTO v_hold;
    INSERT INTO audit_events (
        actor, action, target_type, target_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id,
        principal_type, actor_kind, source, outcome, command_id
    ) VALUES (
        p_actor, 'audit.legal_hold.placed', 'organizations', p_org_id::text, NULL,
        jsonb_build_object('hold_id', v_hold.id, 'org_id', p_org_id,
            'case_ref', v_hold.case_ref, 'basis', v_hold.basis,
            'reason', v_hold.reason, 'applied_by', p_actor, 'applied_at', v_hold.applied_at),
        p_trace_id, p_span_id, p_occurred_at, p_org_id,
        'SUPPORT_OPERATOR', 'SUPPORT_OPERATOR', 'API', 'ALLOWED', gen_random_uuid()
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
    v_hold docs_evidence_legal_holds%ROWTYPE;
BEGIN
    IF p_actor IS NULL THEN
        RAISE EXCEPTION 'legal hold release requires an actor' USING ERRCODE = '22004';
    END IF;
    UPDATE docs_evidence_legal_holds
    SET status = 'RELEASED', released_by = p_actor, released_at = p_occurred_at,
        release_reason = p_reason
    WHERE id = p_hold_id AND evidence_object_id IS NULL AND status = 'ACTIVE'
    RETURNING * INTO v_hold;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no active legal hold found for %', p_hold_id USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO audit_events (
        actor, action, target_type, target_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id,
        principal_type, actor_kind, source, outcome, command_id
    ) VALUES (
        p_actor, 'audit.legal_hold.released', 'organizations', v_hold.org_id::text,
        jsonb_build_object('hold_id', v_hold.id, 'org_id', v_hold.org_id, 'status', 'ACTIVE'),
        jsonb_build_object('hold_id', v_hold.id, 'org_id', v_hold.org_id,
            'release_reason', v_hold.release_reason, 'status', v_hold.status,
            'released_by', p_actor, 'released_at', v_hold.released_at),
        p_trace_id, p_span_id, p_occurred_at, v_hold.org_id,
        'SUPPORT_OPERATOR', 'SUPPORT_OPERATOR', 'API', 'ALLOWED', gen_random_uuid()
    );
END;
$$;

REVOKE ALL ON FUNCTION audit_legal_hold_place(UUID, TEXT, TEXT, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    FROM PUBLIC, console_rt;
GRANT EXECUTE ON FUNCTION audit_legal_hold_place(UUID, TEXT, TEXT, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    TO console_platform_force_cmd;
REVOKE ALL ON FUNCTION audit_legal_hold_release(UUID, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    FROM PUBLIC, console_rt;
GRANT EXECUTE ON FUNCTION audit_legal_hold_release(UUID, TEXT, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ)
    TO console_platform_force_cmd;


CREATE OR REPLACE FUNCTION platform_remove_organization(p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    sentinel_org CONSTANT UUID := '00000000-0000-0000-0000-00000000face'::uuid;
    org_exists   BOOLEAN;
    has_data     BOOLEAN;
BEGIN
    IF p_id = sentinel_org THEN
        RETURN 'not_found';
    END IF;

    SET LOCAL row_security = off;

    org_exists := platform_lock_organization_accounts_for_removal(p_id) IS NOT NULL;
    IF NOT org_exists THEN
        SET LOCAL row_security = on;
        RETURN 'not_found';
    END IF;

    IF EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id AND status = 'ACTIVE') THEN
        RETURN 'blocked_legal_hold';
    END IF;

    SELECT
        EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registry_equipment           WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM work_orders                   WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registry_sites               WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registry_customers           WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM inspection_rounds            WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM regular_inspection_schedules WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM sales_listings               WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM customer_inquiries           WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_rental_quotes      WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_purchase_requests  WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_purchase_attachments WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_regular_purchase_prices WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_expense_ledger      WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM equipment_cost_ledger        WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM messenger_threads            WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM location_consents            WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM site_attendance_events       WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM governance_findings          WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registered_devices rd
                JOIN users u ON u.id = rd.user_id WHERE u.org_id = p_id)
    INTO has_data;

    IF has_data THEN
        SET LOCAL row_security = on;
        RETURN 'blocked_has_data';
    END IF;

    PERFORM auth_security.retire_company_accounts(p_id);

    DELETE FROM auth_refresh_tokens         WHERE org_id = p_id;
    DELETE FROM auth_refresh_token_families WHERE org_id = p_id;
    DELETE FROM auth_webauthn_credentials   WHERE org_id = p_id;
    DELETE FROM auth_webauthn_ceremonies
        WHERE user_id IN (SELECT id FROM users WHERE org_id = p_id);
    DELETE FROM auth_bootstrap_credentials  WHERE org_id = p_id;

    DELETE FROM user_branches WHERE org_id = p_id;

    PERFORM set_config('app.audit_rehome', 'on', true);
    UPDATE audit_events
    SET org_id    = sentinel_org,
        actor     = NULL,
        branch_id = NULL
    WHERE org_id = p_id;
    PERFORM set_config('app.audit_rehome', 'off', true);

    DELETE FROM users    WHERE org_id = p_id;
    DELETE FROM branches WHERE org_id = p_id;
    DELETE FROM regions  WHERE org_id = p_id;

    DELETE FROM organizations WHERE id = p_id;

    SET LOCAL row_security = on;
    RETURN 'removed';
END;
$$;

REVOKE ALL ON FUNCTION platform_remove_organization(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_remove_organization(UUID) TO console_rt;

CREATE OR REPLACE FUNCTION platform_force_remove_organization_command(
    p_id UUID, p_actor UUID, p_trace_id CHAR(32), p_span_id CHAR(16), p_occurred_at TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_slug TEXT;
    v_name TEXT;
    v_outcome TEXT;
    v_wiped JSONB;
BEGIN
    SET LOCAL row_security = off;
    -- Follow the account-before-organization lock order used by both removal paths.
    PERFORM platform_lock_organization_accounts_for_removal(p_id);
    IF EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id AND status = 'ACTIVE') THEN
        INSERT INTO audit_events (org_id, actor, action, target_type, target_id,
            after_snap, trace_id, span_id, occurred_at,
            principal_type, actor_kind, source, outcome, command_id)
        VALUES (p_id, p_actor, 'platform.tenant.force_remove.refused', 'organizations', p_id::text,
            jsonb_build_object('reason_code', 'blocked_legal_hold'), p_trace_id, p_span_id, p_occurred_at,
            'SUPPORT_OPERATOR', 'SUPPORT_OPERATOR', 'API', 'DENIED', gen_random_uuid());
        RETURN 'blocked_legal_hold';
    END IF;
    SELECT slug, name INTO v_slug, v_name FROM organizations WHERE id = p_id;
    SELECT jsonb_build_object(
        'users', (SELECT count(*) FROM users WHERE org_id = p_id),
        'registry_customers', (SELECT count(*) FROM registry_customers WHERE org_id = p_id),
        'registry_sites', (SELECT count(*) FROM registry_sites WHERE org_id = p_id),
        'registry_equipment', (SELECT count(*) FROM registry_equipment WHERE org_id = p_id),
        'work_orders', (SELECT count(*) FROM work_orders WHERE org_id = p_id),
        'financial_rental_quotes', (SELECT count(*) FROM financial_rental_quotes WHERE org_id = p_id),
        'financial_purchase_requests', (SELECT count(*) FROM financial_purchase_requests WHERE org_id = p_id),
        'messenger_threads', (SELECT count(*) FROM messenger_threads WHERE org_id = p_id),
        'evidence_media', (SELECT count(*) FROM evidence_media WHERE org_id = p_id),
        'audit_events', (SELECT count(*) FROM audit_events WHERE org_id = p_id)
    ) INTO v_wiped;
    v_outcome := platform_force_remove_organization(p_id);
    IF v_outcome <> 'removed' THEN
        RETURN v_outcome;
    END IF;
    INSERT INTO audit_events (
        org_id, actor, action, target_type, target_id, branch_id,
        before_snap, after_snap, trace_id, span_id, occurred_at
    ) VALUES (
        NULL, p_actor, 'platform.tenant.force_remove', 'organizations', p_id::text, NULL,
        jsonb_build_object('org_id', p_id, 'slug', v_slug, 'name', v_name, 'wiped', v_wiped), NULL,
        p_trace_id, p_span_id, p_occurred_at
    );
    RETURN 'removed';
END;
$$;
REVOKE ALL ON FUNCTION platform_force_remove_organization_command(UUID, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ) FROM PUBLIC, console_rt;
GRANT EXECUTE ON FUNCTION platform_force_remove_organization_command(UUID, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ) TO console_platform_force_cmd;
REVOKE EXECUTE ON FUNCTION platform_force_remove_organization(UUID) FROM console_platform_force_cmd;

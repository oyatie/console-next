-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: old clients keep reading the non-null wire comment; old ledger rows are immutable.
SET LOCAL lock_timeout = '2s';
ALTER TABLE employee_lifecycle_events ADD COLUMN comment_code TEXT CHECK (comment_code IS NULL OR comment_code ~ '^[a-z][a-z0-9_]*$');
-- A system code supplies the note; user-authored rows still require a reason or nonblank comment.
ALTER TABLE employee_lifecycle_events DROP CONSTRAINT employee_lifecycle_events_reason_present;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_reason_present
    CHECK (reason_code IS NOT NULL OR comment IS NOT NULL OR comment_code IS NOT NULL);
COMMENT ON COLUMN employee_lifecycle_events.comment_code IS 'pd:none — system-authored comment catalog code; free text remains in comment';

CREATE OR REPLACE FUNCTION leave_api.create_employee(
    p_org_id UUID, p_employee_id UUID, p_employee_number TEXT, p_name TEXT,
    p_company TEXT, p_employment_type TEXT, p_phone_e164 TEXT, p_org_unit TEXT,
    p_position TEXT, p_site TEXT, p_home_branch_id UUID, p_base_pay NUMERIC,
    p_idempotency_key TEXT, p_request_hash TEXT, p_actor UUID, p_trace_id TEXT,
    p_span_id TEXT
) RETURNS TABLE(employee_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
    v_stored_hash TEXT;
    v_existing_employee_id UUID;
BEGIN
    PERFORM leave_api.assert_context(p_org_id, p_actor, p_trace_id, p_span_id);
    PERFORM leave_api.assert_employee_directory_manager(p_org_id, p_actor);

    IF NOT EXISTS (
        SELECT 1 FROM public.branches b
        WHERE b.org_id = p_org_id
          AND b.id = p_home_branch_id
          AND b.deactivated_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'employee_create.active_branch_required';
    END IF;

    INSERT INTO public.employee_create_idempotency (org_id, idempotency_key, request_hash)
    VALUES (p_org_id, p_idempotency_key, p_request_hash)
    ON CONFLICT (org_id, idempotency_key) DO NOTHING;

    SELECT i.request_hash, i.employee_id
      INTO v_stored_hash, v_existing_employee_id
      FROM public.employee_create_idempotency i
     WHERE i.org_id = p_org_id AND i.idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF v_stored_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'employee_create.idempotency_conflict';
    END IF;
    IF v_existing_employee_id IS NOT NULL THEN
        RETURN QUERY SELECT v_existing_employee_id, true;
        RETURN;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(p_org_id::TEXT || ':' || p_employee_number)
    );
    IF EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.org_id = p_org_id AND e.employee_number = p_employee_number
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'employee_create.employee_number_conflict';
    END IF;

    INSERT INTO public.employees (
        id, org_id, company, name, employee_number, org_unit, position,
        worksite_name, home_branch_id, source_filename, source_sheet,
        source_row, source_key, raw_row, source_metadata,
        identity_resolution_strategy, identity_resolution_confidence,
        identity_review_required, identity_name_only_merge
    ) VALUES (
        p_employee_id, p_org_id, p_company, p_name, p_employee_number,
        p_org_unit, p_position, p_site, p_home_branch_id, 'console', 'people',
        1, 'console:' || p_employee_number, '{}'::jsonb, '{}'::jsonb,
        'employee_number', 'high', false, false
    );
    INSERT INTO public.employee_employment_profiles (
        employee_id, org_id, employment_type, phone_e164, base_pay,
        idempotency_key, request_hash, created_by
    ) VALUES (
        p_employee_id, p_org_id, p_employment_type, p_phone_e164, p_base_pay,
        p_idempotency_key, p_request_hash, p_actor
    );
    INSERT INTO public.employee_lifecycle_events (
        id, org_id, employee_id, event_type, to_status, to_company,
        to_org_unit, to_position, effective_date, comment, comment_code, signoffs, created_by
    ) VALUES (
        pg_catalog.gen_random_uuid(), p_org_id, p_employee_id, 'ONBOARD', 'ACTIVE',
        p_company, p_org_unit, p_position, ((pg_catalog.now() AT TIME ZONE 'Asia/Seoul')::DATE)::TEXT,
        NULL, 'created_by_registration', '{}'::jsonb, p_actor
    );
    UPDATE public.employee_create_idempotency
       SET employee_id = p_employee_id
     WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key;
    INSERT INTO public.audit_events (
        actor, action, target_type, target_id, branch_id, before_snap, after_snap,
        trace_id, span_id, occurred_at, org_id
    ) VALUES (
        p_actor, 'employee.create', 'employee', p_employee_id::TEXT, p_home_branch_id,
        NULL, pg_catalog.jsonb_build_object(
            'employee_number', p_employee_number,
            'employment_type', p_employment_type,
            'home_branch_id', p_home_branch_id,
            'compensation_recorded', true,
            'phone_recorded', true
        ), p_trace_id, p_span_id, pg_catalog.statement_timestamp(), p_org_id
    );
    RETURN QUERY SELECT p_employee_id, false;
END;
$$;

-- PA-DATE (pre-alpha gate U24; parity L7, SC-FND-015, §3.3 입사일):
-- employees.hire_date / exit_date TEXT → DATE, the EXPAND step.
-- Numbered head+1 of hard/emp-model (0256); INTEG renumbers at the batch merge.
--
-- Expand-contract. Two DATE columns stand beside the legacy TEXT pair and one
-- trigger keeps each pair in step in both directions, so every writer keeps
-- working unchanged (directory create through the canonical owner, the 0166
-- import apply, other lanes' branches) while readers move to the DATE
-- columns. A writer may set either side; setting both to different days is a
-- 23514. The CONTRACT (drop the TEXT pair, keep the DATE names) is a later
-- migration, once no writer names the TEXT columns; it must first find no row
-- whose TEXT is set while its DATE is NULL.
--
-- No guessing (hr-reports-registers P-3): a TEXT value that is not exactly a
-- real YYYY-MM-DD day stays as typed and its DATE is NULL. Those rows are the
-- ones `hire_date IS NOT NULL AND hire_on IS NULL` finds.
--
-- One KST clock: the 0183 create function (unused by the console since R2;
-- kept for its callers) recorded its ONBOARD date as CURRENT_DATE::TEXT, the
-- database session's calendar day. It now records the Asia/Seoul day, the
-- clock every HR writer uses (hr adapter `clock::today_kst`).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The strict parser: exactly YYYY-MM-DD and a real calendar day, else NULL.
CREATE FUNCTION public.employees_iso_date(p_text TEXT)
RETURNS DATE LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog AS $$
DECLARE
    v TEXT := btrim(p_text);
BEGIN
    IF v IS NULL OR v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN NULL;
    END IF;
    RETURN make_date(substr(v, 1, 4)::INT, substr(v, 6, 2)::INT, substr(v, 9, 2)::INT);
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The DATE columns, filled from the TEXT values they mirror.
ALTER TABLE employees
    ADD COLUMN hire_on DATE NULL,
    ADD COLUMN exit_on DATE NULL;

UPDATE employees
   SET hire_on = public.employees_iso_date(hire_date),
       exit_on = public.employees_iso_date(exit_date)
 WHERE hire_date IS NOT NULL OR exit_date IS NOT NULL;

COMMENT ON COLUMN employees.hire_on IS 'pd:personal — 입사일 (DATE, KST 달력일; 근기법 시행령 §20 명부 기재사항); hire_date TEXT의 확장 단계 짝';
COMMENT ON COLUMN employees.exit_on IS 'pd:personal — 퇴직일 (DATE, KST 달력일); exit_date TEXT의 확장 단계 짝';

-- ---------------------------------------------------------------------------
-- 3. The pairs stay in step while both exist.
CREATE FUNCTION public.employees_dates_in_step()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE
    hire_text_set BOOLEAN;
    hire_date_set BOOLEAN;
    exit_text_set BOOLEAN;
    exit_date_set BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        hire_text_set := NEW.hire_date IS NOT NULL;
        hire_date_set := NEW.hire_on IS NOT NULL;
        exit_text_set := NEW.exit_date IS NOT NULL;
        exit_date_set := NEW.exit_on IS NOT NULL;
    ELSE
        hire_text_set := NEW.hire_date IS DISTINCT FROM OLD.hire_date;
        hire_date_set := NEW.hire_on IS DISTINCT FROM OLD.hire_on;
        exit_text_set := NEW.exit_date IS DISTINCT FROM OLD.exit_date;
        exit_date_set := NEW.exit_on IS DISTINCT FROM OLD.exit_on;
    END IF;

    IF hire_text_set AND hire_date_set THEN
        IF NEW.hire_on IS DISTINCT FROM public.employees_iso_date(NEW.hire_date) THEN
            RAISE EXCEPTION 'hire_date and hire_on name different days'
                USING ERRCODE = '23514';
        END IF;
    ELSIF hire_date_set THEN
        NEW.hire_date := to_char(NEW.hire_on, 'YYYY-MM-DD');
    ELSIF hire_text_set THEN
        NEW.hire_on := public.employees_iso_date(NEW.hire_date);
    END IF;

    IF exit_text_set AND exit_date_set THEN
        IF NEW.exit_on IS DISTINCT FROM public.employees_iso_date(NEW.exit_date) THEN
            RAISE EXCEPTION 'exit_date and exit_on name different days'
                USING ERRCODE = '23514';
        END IF;
    ELSIF exit_date_set THEN
        NEW.exit_date := to_char(NEW.exit_on, 'YYYY-MM-DD');
    ELSIF exit_text_set THEN
        NEW.exit_on := public.employees_iso_date(NEW.exit_date);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_employees_dates_in_step
    BEFORE INSERT OR UPDATE OF hire_date, exit_date, hire_on, exit_on ON employees
    FOR EACH ROW EXECUTE FUNCTION public.employees_dates_in_step();

-- ---------------------------------------------------------------------------
-- 4. The 0183 create function: the ONBOARD date on the KST calendar.
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
        to_org_unit, to_position, effective_date, comment, signoffs, created_by
    ) VALUES (
        pg_catalog.gen_random_uuid(), p_org_id, p_employee_id, 'ONBOARD', 'ACTIVE',
        p_company, p_org_unit, p_position, ((pg_catalog.now() AT TIME ZONE 'Asia/Seoul')::DATE)::TEXT,
        'Created through People & Workforce', '{}'::jsonb, p_actor
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
ALTER FUNCTION leave_api.create_employee(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, NUMERIC,
    TEXT, TEXT, UUID, TEXT, TEXT
) OWNER TO console_leave_definer;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS leave_requests_org_subject_dates_idx
    ON public.leave_requests (org_id, subject_employee_id, start_date, end_date)
    WHERE status IN ('pending', 'approved');

GRANT SELECT ON public.attendance_month_closes, public.period_locks TO console_leave_definer;

CREATE OR REPLACE FUNCTION leave_api.create_request(
    p_org_id UUID, p_request_id UUID, p_requester UUID,
    p_leave_type TEXT, p_start_date DATE, p_end_date DATE,
    p_partial_day_period TEXT, p_review_reasons TEXT[],
    p_evidence_home_branch_id UUID, p_date_charges JSONB, p_calendar_revision_ref JSONB,
    p_policy_revision_ref JSONB, p_supporting_source_refs JSONB,
    p_submission_key UUID,
    p_trace_id TEXT, p_span_id TEXT
) RETURNS TABLE(request_id UUID, subject_employee_id UUID, branch_id UUID,
                request_version BIGINT, charge_version BIGINT,
                charge_units NUMERIC(16,6), server_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
    v_subject UUID;
    v_branch UUID;
    v_snapshot JSONB;
    v_units NUMERIC(16,6);
    v_digest TEXT;
    v_submission_digest TEXT;
    v_resolved BOOLEAN := p_date_charges IS NOT NULL;
    v_resolution_id UUID;
    v_existing public.leave_requests%ROWTYPE;
    v_existing_server_digest TEXT;
BEGIN
    PERFORM leave_api.assert_context(p_org_id, p_requester, p_trace_id, p_span_id);
    IF p_submission_key IS NULL
       OR p_end_date < p_start_date
       OR p_leave_type NOT IN ('annual','half_day')
       OR (p_leave_type = 'half_day') IS DISTINCT FROM (p_partial_day_period IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'leave_create.invalid_intent';
    END IF;

    -- Idempotency is bound only to normalized client intent. Mutable routing,
    -- overlap, closed-period, and evidence checks occur after this replay check
    -- so committed responses replay cleanly even if state changes later.
    v_submission_digest := pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.jsonb_build_object(
            'leave_type', p_leave_type,
            'start_date', p_start_date,
            'end_date', p_end_date,
            'partial_day_period', p_partial_day_period
        )::TEXT, 'UTF8'), 'sha256'), 'hex');
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_org_id::TEXT || ':' || p_requester::TEXT || ':' || p_submission_key::TEXT, 166
    ));
    SELECT * INTO v_existing
      FROM public.leave_requests lr
     WHERE lr.org_id = p_org_id
       AND lr.requester_user_id = p_requester
       AND lr.submission_key = p_submission_key;
    IF FOUND THEN
        IF v_existing.submission_digest IS DISTINCT FROM v_submission_digest THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='leave_create.idempotency_conflict';
        END IF;
        SELECT r.server_digest INTO v_existing_server_digest
          FROM public.leave_charge_resolutions r
         WHERE r.org_id = p_org_id
           AND r.request_id = v_existing.id
           AND r.charge_version = 1
           AND v_existing.submission_initial_charge_version = 1;
        RETURN QUERY SELECT v_existing.id, v_existing.subject_employee_id,
            v_existing.branch_id, 1::BIGINT,
            v_existing.submission_initial_charge_version,
            CASE WHEN v_existing.submission_initial_charge_version = 0 THEN NULL::NUMERIC
                 ELSE (SELECT r.charge_units
                         FROM public.leave_charge_resolutions r
                        WHERE r.org_id = p_org_id
                          AND r.request_id = v_existing.id
                          AND r.charge_version = 1) END,
            v_existing_server_digest;
        RETURN;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_requester::TEXT, 166));
    SELECT e.id, e.home_branch_id INTO v_subject, v_branch
      FROM public.users u
      JOIN public.employees e ON e.id = u.employee_id AND e.org_id = u.org_id
     WHERE u.id = p_requester AND u.org_id = p_org_id AND u.is_active
       AND e.employment_status = 'ACTIVE'
     FOR UPDATE OF e;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'leave_create.self_employee_required';
    END IF;
    IF v_branch IS NOT NULL THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_branch::TEXT, 166));
    END IF;
    IF v_branch IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.branches b
        WHERE b.id = v_branch AND b.org_id = p_org_id AND b.deactivated_at IS NULL
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'leave_create.home_branch_required';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.leave_requests lr
         WHERE lr.org_id = p_org_id
           AND lr.subject_employee_id = v_subject
           AND lr.status IN ('pending', 'approved')
           AND lr.start_date <= p_end_date
           AND lr.end_date >= p_start_date
           AND NOT (
               p_leave_type = 'half_day'
               AND lr.leave_type = 'half_day'
               AND lr.start_date = lr.end_date
               AND p_start_date = p_end_date
               AND lr.partial_day_period IS DISTINCT FROM p_partial_day_period
           )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'leave_create.overlapping_request';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.period_locks pl
         WHERE pl.org_id = p_org_id
           AND pl.domain = 'payroll'
           AND (
               pl.unlocked_at IS NULL
               OR (
                   COALESCE(pl.relock_at <= pg_catalog.now(), FALSE)
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.period_locks s
                        WHERE s.org_id = pl.org_id
                          AND s.domain = pl.domain
                          AND s.period_start = pl.period_start
                          AND s.period_end = pl.period_end
                          AND s.locked_at > pl.unlocked_at
                   )
               )
           )
           AND pl.period_start <= p_end_date
           AND pl.period_end >= p_start_date
    ) OR EXISTS (
        SELECT 1
          FROM public.attendance_month_closes amc
         WHERE amc.org_id = p_org_id
           AND amc.month >= pg_catalog.date_trunc('month', p_start_date)::date
           AND amc.month <= pg_catalog.date_trunc('month', p_end_date)::date
           AND (amc.branch_id = v_branch
                OR (amc.branch_id IS NULL AND amc.period_lock_id IS NULL))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'leave_create.period_closed';
    END IF;

    IF v_resolved IS DISTINCT FROM (p_review_reasons IS NULL OR cardinality(p_review_reasons) = 0)
       OR (v_resolved AND p_evidence_home_branch_id IS DISTINCT FROM v_branch)
       OR (NOT v_resolved AND (p_evidence_home_branch_id IS NOT NULL
           OR p_date_charges IS NOT NULL
           OR p_calendar_revision_ref IS NOT NULL
           OR p_policy_revision_ref IS NOT NULL
           OR p_supporting_source_refs IS NOT NULL)) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'leave_create.invalid_charge_choice';
    END IF;
    IF NOT v_resolved AND (
        cardinality(p_review_reasons) = 0 OR p_review_reasons IS NULL
        OR pg_catalog.array_position(p_review_reasons, NULL) IS NOT NULL
        OR NOT p_review_reasons <@ ARRAY['missing_calendar','ambiguous_calendar',
            'calendar_source_unavailable','missing_policy','ambiguous_policy',
            'policy_source_unavailable']::TEXT[]
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'leave_create.invalid_review_reasons';
    END IF;

    IF v_resolved THEN
        SELECT c.snapshot, c.charge_units, c.server_digest
          INTO v_snapshot, v_units, v_digest
          FROM leave_api.canonical_charge_snapshot(v_branch, p_leave_type,
               p_partial_day_period, p_start_date, p_end_date, p_date_charges,
               p_calendar_revision_ref, p_policy_revision_ref,
               p_supporting_source_refs) c;
    END IF;

    INSERT INTO public.leave_requests
        (id, org_id, branch_id, requester_user_id, subject_employee_id, days,
         leave_type, start_date, end_date, partial_day_period, status,
         charge_state, charge_review_reasons, charge_units, charge_version,
         submission_key, submission_digest, submission_initial_charge_version)
    VALUES
        (p_request_id, p_org_id, v_branch, p_requester, v_subject,
         CASE WHEN p_leave_type = 'half_day' THEN 0.5::NUMERIC
              ELSE (p_end_date - p_start_date + 1)::NUMERIC END,
         p_leave_type, p_start_date, p_end_date,
         p_partial_day_period, 'pending', 'review_required',
         CASE WHEN v_resolved THEN ARRAY['missing_calendar']::TEXT[] ELSE p_review_reasons END,
         NULL, 0, p_submission_key, v_submission_digest,
         CASE WHEN v_resolved THEN 1 ELSE 0 END);

    IF v_resolved THEN
        v_resolution_id := public.gen_random_uuid();
        INSERT INTO public.leave_charge_resolutions
            (id, org_id, request_id, charge_version, home_branch_id, charge_units,
             date_charges, calendar_revision_ref, policy_revision_ref,
             supporting_source_refs, snapshot, server_digest, resolution_origin,
             resolved_by, resolved_at)
        VALUES
            (v_resolution_id, p_org_id, p_request_id, 1, v_branch, v_units,
             p_date_charges, p_calendar_revision_ref, p_policy_revision_ref,
             p_supporting_source_refs, v_snapshot, v_digest, 'automated', NULL, pg_catalog.statement_timestamp());
        UPDATE public.leave_requests
           SET charge_state = 'resolved',
               charge_review_reasons = ARRAY[]::TEXT[],
               charge_units = v_units,
               charge_version = 1,
               current_charge_resolution_id = v_resolution_id
         WHERE org_id = p_org_id AND id = p_request_id;
    END IF;

    INSERT INTO public.audit_events
        (actor, action, target_type, target_id, branch_id, before_snap, after_snap,
         trace_id, span_id, occurred_at, org_id)
    VALUES
        (p_requester, 'leave_request.create', 'leave_request', p_request_id::TEXT,
         v_branch, NULL,
         pg_catalog.jsonb_build_object('status','pending','leave_type',p_leave_type,
            'subject_employee_id',v_subject,'branch_id',v_branch,
            'charge_state',CASE WHEN v_resolved THEN 'resolved' ELSE 'review_required' END,
            'request_version',1,
            'charge_version',CASE WHEN v_resolved THEN 1 ELSE 0 END,
            'server_digest',v_digest),
         p_trace_id, p_span_id, pg_catalog.statement_timestamp(), p_org_id);

    RETURN QUERY SELECT p_request_id, v_subject, v_branch, 1::BIGINT,
        CASE WHEN v_resolved THEN 1::BIGINT ELSE 0::BIGINT END, v_units, v_digest;
END;
$$;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Ordinary home-branch writes recheck employee state in the owning transaction.
SET LOCAL lock_timeout = '2s';
CREATE OR REPLACE FUNCTION leave_api.set_employee_home_branch(
    p_org_id UUID, p_employee_id UUID, p_home_branch_id UUID,
    p_expected_updated_at TIMESTAMPTZ, p_actor UUID,
    p_trace_id TEXT, p_span_id TEXT
) RETURNS TABLE(employee_id UUID, home_branch_id UUID, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
    v_status TEXT;
    v_old_branch UUID;
    v_old_updated TIMESTAMPTZ;
    v_new_updated TIMESTAMPTZ;
BEGIN
    PERFORM leave_api.assert_context(p_org_id,p_actor,p_trace_id,p_span_id);
    SELECT e.home_branch_id,e.updated_at,e.employment_status INTO v_old_branch,v_old_updated,v_status
      FROM public.employees e WHERE e.org_id=p_org_id AND e.id=p_employee_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='leave_home_branch.employee_not_found'; END IF;
    IF v_status = 'EXITED' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='leave_home_branch.employee_exited_read_only'; END IF;
    IF v_old_updated IS DISTINCT FROM p_expected_updated_at THEN
        RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='leave_home_branch.concurrent_modification';
    END IF;
    IF v_old_branch IS NULL OR v_old_branch = p_home_branch_id THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_home_branch_id::TEXT, 166));
    ELSIF v_old_branch::TEXT < p_home_branch_id::TEXT THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_old_branch::TEXT, 166));
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_home_branch_id::TEXT, 166));
    ELSE
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_home_branch_id::TEXT, 166));
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_old_branch::TEXT, 166));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.org_id=p_org_id
                   AND b.id=p_home_branch_id AND b.deactivated_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='leave_home_branch.active_branch_required';
    END IF;
    IF v_old_branch IS NULL THEN
        -- An unassigned employee has no branch-scoped owner yet. Only the
        -- organization-wide SUPER_ADMIN capability may establish that first
        -- routing authority; a target-branch admin cannot claim the employee.
        PERFORM leave_api.assert_org_admin(p_org_id,p_actor);
    ELSE
        PERFORM leave_api.assert_manager(p_org_id,p_actor,v_old_branch);
        PERFORM leave_api.assert_manager(p_org_id,p_actor,p_home_branch_id);
    END IF;
    UPDATE public.employees e SET home_branch_id=p_home_branch_id,updated_at=pg_catalog.now()
     WHERE e.org_id=p_org_id AND e.id=p_employee_id RETURNING e.updated_at INTO v_new_updated;
    INSERT INTO public.audit_events
        (actor,action,target_type,target_id,branch_id,before_snap,after_snap,
         trace_id,span_id,occurred_at,org_id)
    VALUES
        (p_actor,'employee.home_branch_set','employee',p_employee_id::TEXT,p_home_branch_id,
         pg_catalog.jsonb_build_object('home_branch_id',v_old_branch,'updated_at',v_old_updated),
         pg_catalog.jsonb_build_object('home_branch_id',p_home_branch_id,'updated_at',v_new_updated),
         p_trace_id,p_span_id,pg_catalog.statement_timestamp(),p_org_id);
    RETURN QUERY SELECT p_employee_id,p_home_branch_id,v_new_updated;
END;
$$;
ALTER FUNCTION leave_api.set_employee_home_branch(UUID, UUID, UUID, TIMESTAMPTZ, UUID, TEXT, TEXT)
    OWNER TO console_leave_definer;

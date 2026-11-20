-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Restrict new me_access_log_subject_event_ids helper EXECUTE from PUBLIC to console_rt; no existing tables or N-1 writers change.
-- Tenant-fenced index lookup helper for GET /api/v1/me/access-log.
-- PostgreSQL RLS blocks non-leakproof jsonb operators (`?`, `->`, `@>`) from
-- matching partial GIN indexes directly on `audit_events` under `console_rt`;
-- this helper enforces `app.current_org`, returns only matching event UUIDs
-- via `idx_audit_events_subject_ids_gin` / `idx_audit_events_user_subject_ids_gin`,
-- and leaves row projection and RLS filtering on `audit_events` to the caller.
CREATE OR REPLACE FUNCTION public.me_access_log_subject_event_ids(
    p_org_id UUID,
    p_user_id UUID,
    p_employee_id UUID
)
RETURNS TABLE (id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
ROWS 10
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
    IF p_org_id IS NULL
       OR p_user_id IS NULL
       OR p_org_id IS DISTINCT FROM NULLIF(pg_catalog.current_setting('app.current_org', true), '')::uuid
    THEN
        RETURN;
    END IF;

    IF p_employee_id IS NOT NULL THEN
        RETURN QUERY
        SELECT a.id
        FROM public.audit_events a
        WHERE a.org_id = p_org_id
          AND (
              (a.after_snap ? 'subject_ids'
               AND a.after_snap->'subject_ids' @> pg_catalog.jsonb_build_array(p_employee_id::text))
              OR (a.target_type = 'user'
                  AND a.after_snap ? 'subject_ids'
                  AND a.after_snap->'subject_ids' @> pg_catalog.jsonb_build_array(p_user_id::text))
              OR (a.after_snap ? 'user_subject_ids'
                  AND a.after_snap->'user_subject_ids' @> pg_catalog.jsonb_build_array(p_user_id::text))
          );
    ELSE
        RETURN QUERY
        SELECT a.id
        FROM public.audit_events a
        WHERE a.org_id = p_org_id
          AND (
              (a.target_type = 'user'
                  AND a.after_snap ? 'subject_ids'
                  AND a.after_snap->'subject_ids' @> pg_catalog.jsonb_build_array(p_user_id::text))
              OR (a.after_snap ? 'user_subject_ids'
                  AND a.after_snap->'user_subject_ids' @> pg_catalog.jsonb_build_array(p_user_id::text))
          );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.me_access_log_subject_event_ids(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.me_access_log_subject_event_ids(UUID, UUID, UUID) TO console_rt;

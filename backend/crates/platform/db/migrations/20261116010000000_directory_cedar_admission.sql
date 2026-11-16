-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Cedar owns admission. Command-only callers and the import settlement's
-- applied-run evidence protect writes; this leaf guard validates identity only.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION leave_api.assert_employee_directory_manager(
    p_org_id UUID, p_actor UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.org_id = p_org_id AND u.id = p_actor AND u.is_active
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='employee_create.actor_forbidden';
    END IF;
END;
$$;
-- CREATE OR REPLACE preserves the existing definer owner and owner-only ACL.

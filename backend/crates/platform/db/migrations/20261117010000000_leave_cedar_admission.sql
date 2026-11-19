-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Cedar owns admission at the employee and routing scopes in the server.
-- Command-only SQL writers retain tenant and active-identity checks.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION leave_api.assert_manager(
    p_org_id UUID, p_actor UUID, p_branch_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.org_id = p_org_id AND u.id = p_actor AND u.is_active
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='leave_write.branch_forbidden';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION leave_api.assert_org_admin(
    p_org_id UUID, p_actor UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.org_id = p_org_id AND u.id = p_actor AND u.is_active
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='leave_write.org_admin_required';
    END IF;
END;
$$;
-- CREATE OR REPLACE preserves the existing definer owner and owner-only ACLs.

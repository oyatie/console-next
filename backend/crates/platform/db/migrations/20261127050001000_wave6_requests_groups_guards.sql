-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce single pending group join invitation per org, org_id immutability trigger, and parameterized invitation lookup functions.
-- contract-of: 20261127050000000
SET LOCAL lock_timeout = '2s';

CREATE UNIQUE INDEX platform_group_join_requests_one_pending_idx
    ON platform_group_join_requests (org_id)
    WHERE status = 'PENDING';

CREATE TRIGGER platform_group_join_requests_org_immutable
    BEFORE UPDATE ON platform_group_join_requests
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

CREATE OR REPLACE FUNCTION platform_list_group_pending_invitations(p_group_id UUID)
RETURNS TABLE (
    id UUID,
    group_id UUID,
    group_slug TEXT,
    group_name TEXT,
    org_id UUID,
    org_slug TEXT,
    org_name TEXT,
    status TEXT,
    requested_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    SET LOCAL row_security = off;
    RETURN QUERY
    SELECT
        r.id,
        r.group_id,
        g.slug AS group_slug,
        g.name AS group_name,
        r.org_id,
        o.slug AS org_slug,
        o.name AS org_name,
        r.status,
        r.requested_at,
        r.expires_at
    FROM platform_group_join_requests r
    JOIN groups g ON g.id = r.group_id
    JOIN organizations o ON o.id = r.org_id
    WHERE r.group_id = p_group_id
      AND r.status = 'PENDING'
      AND r.expires_at > now()
    ORDER BY r.requested_at DESC, r.id DESC;
    SET LOCAL row_security = on;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION platform_list_group_pending_invitations(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_group_pending_invitations(UUID) TO console_rt;

CREATE OR REPLACE FUNCTION tenant_list_pending_group_invitations(p_org_id UUID)
RETURNS TABLE (
    id UUID,
    group_id UUID,
    group_slug TEXT,
    group_name TEXT,
    org_id UUID,
    org_slug TEXT,
    org_name TEXT,
    status TEXT,
    requested_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_org_id IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::uuid THEN
        RAISE EXCEPTION 'tenant context mismatch for group invitations'
            USING ERRCODE = '42501';
    END IF;
    SET LOCAL row_security = off;
    RETURN QUERY
    SELECT
        r.id,
        r.group_id,
        g.slug AS group_slug,
        g.name AS group_name,
        r.org_id,
        o.slug AS org_slug,
        o.name AS org_name,
        r.status,
        r.requested_at,
        r.expires_at
    FROM platform_group_join_requests r
    JOIN groups g ON g.id = r.group_id
    JOIN organizations o ON o.id = r.org_id
    WHERE r.org_id = p_org_id
      AND r.status = 'PENDING'
      AND r.expires_at > now()
    ORDER BY r.requested_at DESC, r.id DESC;
    SET LOCAL row_security = on;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION tenant_list_pending_group_invitations(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_list_pending_group_invitations(UUID) TO console_rt;

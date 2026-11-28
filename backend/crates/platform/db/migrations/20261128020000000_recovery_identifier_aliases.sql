-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Restrict recovery identifier resolution to permitted holders while accepting their unexpired login aliases.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION platform_resolve_recovery_identifier(p_login TEXT, p_slug TEXT)
RETURNS TABLE (org_id UUID, user_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.id, u.id
      FROM organization_domains d
      JOIN organizations o ON o.id = d.org_id
      JOIN user_sign_in_ids s ON s.org_id = o.id AND s.login = lower(p_login)
      JOIN users u ON u.org_id = o.id AND u.id = s.user_id AND u.is_active AND u.is_tenant_ops
     WHERE d.slug = lower(p_slug)
       AND (d.retired_at IS NULL OR d.alias_until > now())
       AND (s.retired_at IS NULL OR s.alias_until > now())
       AND o.status = 'ACTIVE'
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform_resolve_recovery_identifier(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_resolve_recovery_identifier(TEXT, TEXT) TO console_rt;

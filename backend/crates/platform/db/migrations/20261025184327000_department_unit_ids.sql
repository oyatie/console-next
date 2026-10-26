-- SPDX-License-Identifier: LicenseRef-Proprietary
SET LOCAL lock_timeout = '2s';

-- One tenant-scoped department set for readiness and its directory remedy.
CREATE FUNCTION department_unit_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT org_unit_id FROM (
        SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes
        FROM org_unit_revisions
        ORDER BY org_unit_id, version DESC
    ) units
    WHERE attributes->>'kind' IN ('department', 'team')
      AND attributes->>'status' IS DISTINCT FROM 'dissolved'
$$;

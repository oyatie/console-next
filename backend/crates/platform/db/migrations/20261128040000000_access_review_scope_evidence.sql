-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Store the scope at review opening and restrict the tenant-scoped historical name lookup to the runtime role.
-- contract-of: 20261127020000000
SET LOCAL lock_timeout = '2s';

ALTER TABLE access_review_items
    ADD COLUMN scope_node_id UUID,
    ADD COLUMN scope_include_descendants BOOLEAN;
COMMENT ON COLUMN access_review_items.scope_node_id IS 'pd:none — immutable target at review opening; null for tenant scope or legacy items';
COMMENT ON COLUMN access_review_items.scope_include_descendants IS 'pd:none — descendant coverage at opening; null for legacy items';

-- Use the revision visible at review opening, including its effective date. Older review rows may
-- still have only a kind; the same lookup can recover their label without presenting a later rename.
CREATE FUNCTION access_review_scope_name(tenant UUID, kind TEXT, target UUID, frozen_at TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql STABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, public AS $$
    SELECT CASE kind
        WHEN 'LEGAL_ENTITY' THEN (SELECT r.name FROM legal_entity_revisions r
            WHERE r.org_id = tenant AND r.legal_entity_id = target AND r.created_at <= frozen_at
              AND r.effective_from <= (frozen_at AT TIME ZONE 'Asia/Seoul')::date
            ORDER BY r.effective_from DESC, r.version DESC LIMIT 1)
        WHEN 'WORKPLACE' THEN (SELECT r.name FROM workplace_revisions r
            WHERE r.org_id = tenant AND r.workplace_id = target AND r.created_at <= frozen_at
              AND r.effective_from <= (frozen_at AT TIME ZONE 'Asia/Seoul')::date
            ORDER BY r.effective_from DESC, r.version DESC LIMIT 1)
        WHEN 'DEPARTMENT' THEN (SELECT r.attributes->>'name' FROM org_unit_revisions r
            WHERE r.org_id = tenant AND r.org_unit_id = target AND r.created_at <= frozen_at
            ORDER BY r.version DESC LIMIT 1)
    END
$$;
REVOKE ALL ON FUNCTION access_review_scope_name(UUID, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_review_scope_name(UUID, TEXT, UUID, TIMESTAMPTZ) TO console_rt;

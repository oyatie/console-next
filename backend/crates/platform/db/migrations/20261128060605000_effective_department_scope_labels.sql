-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Preserve the name lookup signature, grants and undated revisions while applying the effective work date to departments.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION access_review_scope_name(tenant UUID, kind TEXT, target UUID, frozen_at TIMESTAMPTZ)
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
              AND COALESCE(entity_try_iso_date(r.attributes->>'effective_from'), (r.created_at AT TIME ZONE 'Asia/Seoul')::date)
                    <= (frozen_at AT TIME ZONE 'Asia/Seoul')::date
            ORDER BY COALESCE(entity_try_iso_date(r.attributes->>'effective_from'), (r.created_at AT TIME ZONE 'Asia/Seoul')::date) DESC,
                     r.version DESC LIMIT 1)
    END
$$;

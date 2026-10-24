-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand: placement admission and dated reads share the foundation objects' first effective dates.
SET LOCAL lock_timeout = '2s';
CREATE FUNCTION entity_workplace_opens_on(workplace UUID, known_at TIMESTAMPTZ DEFAULT NULL) RETURNS DATE
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT GREATEST(
        (SELECT min(r.effective_from) FROM workplace_revisions r
         WHERE r.org_id = w.org_id AND r.workplace_id = w.id AND (known_at IS NULL OR r.created_at <= known_at)),
        (SELECT min(r.effective_from) FROM legal_entity_revisions r
         WHERE r.org_id = w.org_id AND r.legal_entity_id = w.legal_entity_id AND (known_at IS NULL OR r.created_at <= known_at))
    ) FROM workplaces w WHERE w.id = workplace
$$;
REVOKE ALL ON FUNCTION entity_workplace_opens_on(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entity_workplace_opens_on(UUID, TIMESTAMPTZ) TO console_rt;

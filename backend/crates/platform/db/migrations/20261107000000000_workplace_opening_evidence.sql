-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Expand: retain recorded revisions; an older certificate can establish an unknown incorporation boundary.
-- Rollback: restore the preceding function definition; no stored data changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION entity_workplace_opens_on(workplace UUID, known_at TIMESTAMPTZ DEFAULT NULL) RETURNS DATE
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT GREATEST(
        (SELECT min(r.effective_from) FROM workplace_revisions r
         WHERE r.org_id = w.org_id AND r.workplace_id = w.id AND (known_at IS NULL OR r.created_at <= known_at)),
        (SELECT CASE WHEN bool_or(r.incorporated_on IS NOT NULL) THEN min(r.effective_from)
            ELSE LEAST(min(r.effective_from),
                (SELECT min(c.effective_from) FROM business_registrations b
                 JOIN business_registration_revisions c ON c.org_id = b.org_id AND c.registration_id = b.id
                 WHERE b.org_id = w.org_id AND b.legal_entity_id = w.legal_entity_id AND b.voided_at IS NULL
                   AND (known_at IS NULL OR c.created_at <= known_at))) END
         FROM legal_entity_revisions r
         WHERE r.org_id = w.org_id AND r.legal_entity_id = w.legal_entity_id AND (known_at IS NULL OR r.created_at <= known_at))
    ) FROM workplaces w WHERE w.id = workplace
$$;

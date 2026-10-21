-- 법인명/상호 has exactly one stored source: legal_entity_revisions.name (owner
-- 2026-10-13). Every registration's ① is derived from it at read time.
--
-- Expand step. business_registration_revisions.trade_name is no longer read by the
-- application; the binary keeps writing the entity's name into it only because the
-- N-1 binary of a canary rollout still reads it. A later contract migration drops it.
--
-- Registrations whose 상호 differs from their entity's name are not discarded: each
-- becomes a one-time review item (확인 필요) holding both values. The entity's name
-- stays the source until a person picks one.
SET LOCAL lock_timeout = '2s';

CREATE TABLE legal_entity_name_reviews (
    org_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                 UUID        NOT NULL DEFAULT gen_random_uuid(),
    legal_entity_id    UUID        NOT NULL,
    registration_id    UUID        NOT NULL,
    entity_name        TEXT        NOT NULL,
    registration_name  TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at         TIMESTAMPTZ,
    settled_by         UUID,
    settled_name       TEXT,
    PRIMARY KEY (org_id, id),
    UNIQUE (registration_id),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (settled_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT legal_entity_name_reviews_settled CHECK (
        (settled_at IS NULL) = (settled_by IS NULL) AND (settled_at IS NULL) = (settled_name IS NULL))
);
CREATE INDEX legal_entity_name_reviews_open ON legal_entity_name_reviews (legal_entity_id) WHERE settled_at IS NULL;

-- One item per registration whose latest 상호 differs (ignoring spacing) from its
-- entity's latest name. Idempotent: a rerun raises nothing new. Returns the count.
CREATE FUNCTION legal_entity_name_review_backfill() RETURNS bigint
LANGUAGE sql SET row_security = off AS $$
    WITH ins AS (
        INSERT INTO legal_entity_name_reviews (org_id, legal_entity_id, registration_id, entity_name, registration_name)
        SELECT h.org_id, h.legal_entity_id, h.id, e.name, r.trade_name
        FROM business_registrations h
        JOIN LATERAL (SELECT x.trade_name FROM business_registration_revisions x WHERE x.registration_id = h.id
                      ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true
        JOIN LATERAL (SELECT x.name FROM legal_entity_revisions x WHERE x.legal_entity_id = h.legal_entity_id
                      ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) e ON true
        WHERE h.voided_at IS NULL
          AND regexp_replace(r.trade_name, '\s', '', 'g') <> regexp_replace(e.name, '\s', '', 'g')
        ON CONFLICT (registration_id) DO NOTHING
        RETURNING 1)
    SELECT count(*) FROM ins
$$;
REVOKE ALL ON FUNCTION legal_entity_name_review_backfill() FROM PUBLIC;
SELECT legal_entity_name_review_backfill();

ALTER TABLE legal_entity_name_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity_name_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON legal_entity_name_reviews
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_legal_entity_name_reviews_org_immutable BEFORE UPDATE ON legal_entity_name_reviews
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
REVOKE ALL PRIVILEGES ON legal_entity_name_reviews FROM PUBLIC, console_rt;
GRANT SELECT, UPDATE (settled_at, settled_by, settled_name) ON legal_entity_name_reviews TO console_rt;

COMMENT ON TABLE legal_entity_name_reviews IS 'One-time 확인 필요 items: a registration 상호 that differed from its entity name when the name became single-source';
COMMENT ON COLUMN legal_entity_name_reviews.id IS 'pd:none — row id';
COMMENT ON COLUMN legal_entity_name_reviews.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN legal_entity_name_reviews.legal_entity_id IS 'pd:none — the legal entity whose name is in question';
COMMENT ON COLUMN legal_entity_name_reviews.registration_id IS 'pd:none — the registration that carried the differing 상호';
COMMENT ON COLUMN legal_entity_name_reviews.entity_name IS 'pd:personal — the entity name at migration (may hold a person name typed into it)';
COMMENT ON COLUMN legal_entity_name_reviews.registration_name IS 'pd:personal — the registration 상호 at migration (may hold a person name typed into it)';
COMMENT ON COLUMN legal_entity_name_reviews.created_at IS 'pd:none — when the item was raised';
COMMENT ON COLUMN legal_entity_name_reviews.settled_at IS 'pd:none — when a person settled it; NULL while open';
COMMENT ON COLUMN legal_entity_name_reviews.settled_by IS 'pd:personal — user who settled it';
COMMENT ON COLUMN legal_entity_name_reviews.settled_name IS 'pd:personal — the name the person picked';
-- business_registration_revisions.trade_name keeps its 0257 classification (pd:none); it is deprecated:
-- written as the entity name for N-1 readers, never read, and dropped by the contract migration.

-- A settled review refreshes the 법인 for every reader, like its other writes.
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('legal_entity', 'legal_entity.name_review.settle', 'legal_entity', true);

-- Expand-only: exact service terms and append-only contracting-admin acceptances.
-- Head+1 of this lane's base; INTEG renumbers when the pair lands.
SET LOCAL lock_timeout = '2s';

CREATE TABLE terms_documents (
    version TEXT PRIMARY KEY CHECK (char_length(btrim(version)) BETWEEN 1 AND 40),
    body TEXT NOT NULL CHECK (char_length(btrim(body)) > 0),
    sha256 TEXT GENERATED ALWAYS AS (encode(digest(body, 'sha256'), 'hex')) STORED NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    UNIQUE (version, sha256)
);
ALTER TABLE terms_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY published_terms ON terms_documents FOR SELECT
    USING (published_at <= now());
REVOKE ALL ON terms_documents FROM PUBLIC, console_rt;
GRANT SELECT ON terms_documents TO console_rt;
CREATE TRIGGER trg_terms_documents_immutable BEFORE UPDATE OR DELETE ON terms_documents
    FOR EACH ROW EXECUTE FUNCTION tenant_phase_events_no_update();
COMMENT ON TABLE terms_documents IS 'Global immutable service terms; only the platform migrator publishes approved content';
COMMENT ON COLUMN terms_documents.version IS 'pd:none — published service terms version';
COMMENT ON COLUMN terms_documents.body IS 'pd:none — exact approved service terms text';
COMMENT ON COLUMN terms_documents.sha256 IS 'pd:none — SHA-256 of the exact UTF-8 body';
COMMENT ON COLUMN terms_documents.published_at IS 'pd:none — publication timestamp';

CREATE TABLE tenant_terms_acceptances (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    accepted_by UUID NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, version),
    FOREIGN KEY (version, sha256) REFERENCES terms_documents(version, sha256) ON DELETE RESTRICT,
    FOREIGN KEY (accepted_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
ALTER TABLE tenant_terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_terms_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_terms_acceptances
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON tenant_terms_acceptances FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON tenant_terms_acceptances TO console_rt;
CREATE TRIGGER trg_tenant_terms_acceptances_immutable BEFORE UPDATE ON tenant_terms_acceptances
    FOR EACH ROW EXECUTE FUNCTION tenant_phase_events_no_update();
COMMENT ON TABLE tenant_terms_acceptances IS 'Append-only acceptance of an exact published version by the contracting ops holder';
COMMENT ON COLUMN tenant_terms_acceptances.org_id IS 'pd:none — tenant boundary';
COMMENT ON COLUMN tenant_terms_acceptances.version IS 'pd:none — accepted service terms version';
COMMENT ON COLUMN tenant_terms_acceptances.sha256 IS 'pd:none — accepted exact-text hash';
COMMENT ON COLUMN tenant_terms_acceptances.accepted_by IS 'pd:personal — contracting administrator account';
COMMENT ON COLUMN tenant_terms_acceptances.accepted_at IS 'pd:none — acceptance timestamp';

-- Keep legacy event readers compatible while adding the roles choice.
ALTER TABLE tenant_phase_events DROP CONSTRAINT tenant_phase_events_kind_check;
ALTER TABLE tenant_phase_events ADD CONSTRAINT tenant_phase_events_kind_check CHECK (kind IN (
    'SETUP_OPENED', 'BACKFILLED', 'GO_LIVE', 'TERMS_ACCEPTED',
    'ORG_STEP_SKIPPED', 'EMPLOYEES_STEP_DEFERRED', 'ROLES_STEP_SKIPPED'
)) NOT VALID;
ALTER TABLE tenant_phase_events VALIDATE CONSTRAINT tenant_phase_events_kind_check;

-- Account and role changes also alter onboarding counts and per-viewer actions.
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id)
SELECT DISTINCT target_type, action, 'tenant', false FROM realtime_topic_map
WHERE resource_type IN ('role', 'user')
ON CONFLICT DO NOTHING;

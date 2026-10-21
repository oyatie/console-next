-- BL-009: selective port of aud1 4e658c22's five viewer columns.
-- Existing rows retain encoding v1. No old migration or audit row is rewritten.
SET LOCAL lock_timeout = '2s';
ALTER TABLE audit_events
    ADD COLUMN principal_type TEXT NULL CHECK (principal_type IS NULL OR principal_type IN
        ('TENANT_USER', 'GROUP_ADMIN', 'SUPPORT_OPERATOR', 'SERVICE', 'SYSTEM')),
    ADD COLUMN session_id     UUID NULL,
    ADD COLUMN outcome        TEXT NULL CHECK (outcome IS NULL OR outcome IN ('ALLOWED', 'DENIED')),
    ADD COLUMN actor_display  TEXT NULL CHECK (actor_display IS NULL OR char_length(btrim(actor_display)) BETWEEN 1 AND 200),
    ADD COLUMN actor_employer TEXT NULL CHECK (actor_employer IS NULL OR char_length(btrim(actor_employer)) BETWEEN 1 AND 200);

COMMENT ON COLUMN audit_events.principal_type IS 'pd:none — kind of principal that acted (tenant user, group admin, support operator, service, system)';
COMMENT ON COLUMN audit_events.session_id IS 'pd:personal — refresh-token family the actor acted in (접속기록 session)';
COMMENT ON COLUMN audit_events.outcome IS 'pd:none — ALLOWED or DENIED (refusals are logged too)';
COMMENT ON COLUMN audit_events.actor_display IS 'pd:personal — support operator display name shown to the tenant';
COMMENT ON COLUMN audit_events.actor_employer IS 'pd:none — employer of a support operator (the vendor), never a person';


ALTER TABLE audit_events
    ADD COLUMN source TEXT CHECK (source IN ('FORM','IMPORT','SCHEDULER','API','SYSTEM')),
    ADD COLUMN change_mode TEXT CHECK (change_mode IN ('SETUP','DIRECT','GOVERNED','SOLE_HOLDER','MIGRATION')),
    ADD COLUMN reason_code TEXT,
    ADD COLUMN decision_snapshot JSONB CHECK (jsonb_typeof(decision_snapshot) = 'object' AND NOT jsonb_path_exists(decision_snapshot, '$.* ? (@.type() != "number" || @ < 0)')),
    ADD COLUMN command_id UUID,
    ADD COLUMN scope_ids UUID[],
    ADD COLUMN actor_kind TEXT CHECK (actor_kind IN ('TENANT_USER','OPS_ACCOUNT','GROUP_ADMIN','SUPPORT_OPERATOR','SYSTEM')),
    ADD COLUMN row_hash_version SMALLINT NOT NULL DEFAULT 1 CHECK (row_hash_version IN (1,2));
-- NULL context stays compatible with old writers during a rolling deployment.
ALTER TABLE audit_events ALTER COLUMN row_hash_version SET DEFAULT 2;
CREATE INDEX audit_events_command_idx ON audit_events (org_id, command_id, created_at, id);
CREATE INDEX audit_events_latest_change_idx ON audit_events (org_id, target_type, target_id, created_at DESC, id DESC);
COMMENT ON COLUMN audit_events.source IS 'pd:none — server-resolved command origin';
COMMENT ON COLUMN audit_events.change_mode IS 'pd:none — admission mode in force';
COMMENT ON COLUMN audit_events.reason_code IS 'pd:none — coded command reason';
COMMENT ON COLUMN audit_events.decision_snapshot IS 'pd:none — setting and policy keys and versions, never values';
COMMENT ON COLUMN audit_events.command_id IS 'pd:none — command outcome reference';
COMMENT ON COLUMN audit_events.scope_ids IS 'pd:none — resolved scope identifiers';
COMMENT ON COLUMN audit_events.actor_kind IS 'pd:none — verified actor kind including ops account';
COMMENT ON COLUMN audit_events.row_hash_version IS 'pd:none — immutable encoding version for mixed v1/v2 seals';

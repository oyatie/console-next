-- Version tokens only: immutable overrides, default digests, numeric policy revisions.
SET LOCAL lock_timeout = '2s';
ALTER TABLE audit_events DROP CONSTRAINT audit_events_decision_snapshot_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_decision_snapshot_check CHECK (
    jsonb_typeof(decision_snapshot) = 'object'
    AND NOT jsonb_path_exists(decision_snapshot, '$.* ? (@.type() != "number" && @.type() != "string")')
    AND NOT jsonb_path_exists(decision_snapshot, '$.* ? (@.type() == "number" && @ < 0)')
    AND NOT jsonb_path_exists(decision_snapshot, '$.* ? (@.type() == "string" && !(@ like_regex "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|sha256:[0-9a-f]{64})$"))')
) NOT VALID;
-- Existing valid context rows are preserved; legacy v1 snapshots are empty.
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_decision_snapshot_check;

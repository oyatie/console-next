-- Expand the snapshot to actual immutable setting revision identifiers.
SET LOCAL lock_timeout = '2s';
ALTER TABLE audit_events DROP CONSTRAINT audit_events_decision_snapshot_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_decision_snapshot_check CHECK (
    jsonb_typeof(decision_snapshot) = 'object' AND NOT jsonb_path_exists(decision_snapshot,
        '$.* ? (@.type() != "number" && @.type() != "string")')
);

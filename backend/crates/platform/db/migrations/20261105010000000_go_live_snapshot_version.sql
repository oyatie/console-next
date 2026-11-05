-- migration-class: expand
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Existing snapshots and old writers use the frozen v1 schema.
SET LOCAL lock_timeout = '2s';
ALTER TABLE tenant_phase ADD COLUMN go_live_facts_snapshot_version INTEGER NOT NULL DEFAULT 1
    CHECK (go_live_facts_snapshot_version > 0);
GRANT UPDATE (go_live_facts_snapshot_version) ON tenant_phase TO console_rt;
COMMENT ON COLUMN tenant_phase.go_live_facts_snapshot_version IS
    'pd:none — immutable snapshot schema version; v1 also covers legacy receipts without facts';

CREATE OR REPLACE FUNCTION tenant_phase_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.phase = 'OPERATING' AND NEW.phase <> 'OPERATING' THEN
        RAISE EXCEPTION 'tenant % is OPERATING; the setup phase never reopens', OLD.org_id;
    END IF;
    IF OLD.go_live_at IS NOT NULL
       AND (NEW.go_live_at, NEW.go_live_by, NEW.go_live_preview_digest, NEW.go_live_facts_snapshot, NEW.go_live_facts_snapshot_version)
           IS DISTINCT FROM (OLD.go_live_at, OLD.go_live_by, OLD.go_live_preview_digest, OLD.go_live_facts_snapshot, OLD.go_live_facts_snapshot_version) THEN
        RAISE EXCEPTION 'tenant % go-live record is write-once', OLD.org_id;
    END IF;
    IF (NEW.org_id, NEW.setup_opened_at, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.setup_opened_at, OLD.created_at) THEN
        RAISE EXCEPTION 'tenant_phase identity columns are immutable (org=%)', OLD.org_id;
    END IF;
    RETURN NEW;
END $$;

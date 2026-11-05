-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Counts commit independently of the atomic employee import transaction.
SET LOCAL lock_timeout = '2s';
CREATE TABLE import_apply_progress (
    org_id UUID NOT NULL,
    run_id UUID NOT NULL,
    done BIGINT NOT NULL DEFAULT 0 CHECK (done >= 0),
    total BIGINT NOT NULL CHECK (total >= done),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, run_id),
    FOREIGN KEY (run_id, org_id) REFERENCES data_import_runs(id, org_id) ON DELETE CASCADE
);
COMMENT ON COLUMN import_apply_progress.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN import_apply_progress.run_id IS 'pd:none — import job identifier';
COMMENT ON COLUMN import_apply_progress.done IS 'pd:none — processed row count, not committed employees';
COMMENT ON COLUMN import_apply_progress.total IS 'pd:none — planned row count';
COMMENT ON COLUMN import_apply_progress.updated_at IS 'pd:none — progress publication time';
ALTER TABLE import_apply_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_apply_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_apply_progress
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);
REVOKE ALL ON import_apply_progress FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON import_apply_progress TO console_rt;

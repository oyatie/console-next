-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Track step-up staged identity source and prior employees.id_type for import rollback.
SET LOCAL lock_timeout = '2s';

ALTER TABLE data_import_row_identities
    ADD COLUMN source TEXT CHECK (source IS NULL OR (source IN ('PREVIEW', 'STEP_UP')));

COMMENT ON COLUMN data_import_row_identities.source IS 'pd:none — staging path that created the row (PREVIEW or STEP_UP)';

ALTER TABLE import_run_effects
    ADD COLUMN previous_id_type TEXT CHECK (previous_id_type IS NULL OR (previous_id_type IN ('RRN', 'ARC', 'DOMESTIC_RESIDENCE', 'NOT_ISSUED')));

COMMENT ON COLUMN import_run_effects.previous_id_type IS 'pd:none — employee id_type before rrn_recorded effect';

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Widen the export log kinds for the personnel card section sheet and the worker register; all N-1 writes remain valid.
-- contract-of: 0276
-- Rollback: keep the wider check; the preceding application never writes the new kind.
SET LOCAL lock_timeout = '2s';

ALTER TABLE excel_export_logs DROP CONSTRAINT excel_export_logs_export_kind_check;
ALTER TABLE excel_export_logs ADD CONSTRAINT excel_export_logs_export_kind_check
    CHECK (export_kind IN ('daily_status', 'work_diary', 'kpi', 'employee_directory', 'employee_records', 'worker_register')) NOT VALID;
ALTER TABLE excel_export_logs VALIDATE CONSTRAINT excel_export_logs_export_kind_check;

-- PEOPLE-B (INF-02, GOV-PEO-1): the employee-directory CSV export is logged
-- in excel_export_logs like the reporting exports, with its download 용도
-- (고시 2023-6 §8② 다운로드 사유 확인). Numbered head+1 of the lane's base
-- (0256); INTEG renumbers it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE excel_export_logs
    DROP CONSTRAINT excel_export_logs_export_kind_check,
    ADD CONSTRAINT excel_export_logs_export_kind_check
        CHECK (export_kind IN ('daily_status', 'work_diary', 'kpi', 'employee_directory')),
    ADD COLUMN export_purpose TEXT NULL
        CHECK (export_purpose IS NULL OR export_purpose <> '');

COMMENT ON COLUMN excel_export_logs.export_purpose IS 'pd:none — download purpose code (reason domain export_purpose)';

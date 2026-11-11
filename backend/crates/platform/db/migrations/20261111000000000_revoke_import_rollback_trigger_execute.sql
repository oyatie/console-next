-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Internal rollback audit trigger execution is owner-only.
-- Trigger invocation does not require EXECUTE for the role updating the table.
REVOKE ALL ON FUNCTION leave_api.employee_import_rollback_audit_required()
    FROM PUBLIC, console_rt, console_leave_cmd;

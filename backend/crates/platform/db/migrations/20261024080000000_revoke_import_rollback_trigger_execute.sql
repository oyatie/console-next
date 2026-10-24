-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Trigger invocation needs no caller EXECUTE grant; this definer is not a command entrypoint.
REVOKE ALL ON FUNCTION leave_api.employee_import_rollback_audit_required()
FROM PUBLIC, console_leave_cmd, console_rt;

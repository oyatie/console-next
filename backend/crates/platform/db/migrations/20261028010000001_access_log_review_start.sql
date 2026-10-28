-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: keep the existing command reservations and admit review starts.
SET LOCAL lock_timeout = '2s';
ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check CHECK (operation IN (
 'users.create','employee.lifecycle.create','hr.exit_case.create','employee.lifecycle.bulk',
 'period_lock.lock','period_lock.unlock','period_lock.unlock_approve','period_lock.unlock_reject',
 'employee.correction.bulk','appointment_notice.issue','tenant.domain.request','platform.tenant.rename',
 'certificate.issue','certificate.void','certificate.reissue',
 'platform.tenant.ops_recovery.open','platform.tenant.ops_recovery.approve',
 'platform.tenant.ops_recovery.issue','platform.tenant.ops_recovery.cancel',
 'employee_import.rollback','access_log_review.start')) NOT VALID;
ALTER TABLE api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

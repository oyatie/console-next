-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: retain every previous operation and add certificate commands.
SET LOCAL lock_timeout = '2s';
ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check CHECK(operation IN (
 'users.create','employee.lifecycle.create','hr.exit_case.create','employee.lifecycle.bulk',
 'period_lock.lock','period_lock.unlock','period_lock.unlock_approve','period_lock.unlock_reject',
 'employee.correction.bulk','appointment_notice.issue','tenant.domain.request','platform.tenant.rename',
 'certificate.issue','certificate.void','certificate.reissue'
)) NOT VALID;
ALTER TABLE api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

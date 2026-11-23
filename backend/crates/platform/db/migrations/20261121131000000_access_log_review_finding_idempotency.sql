-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Expand api_idempotency_keys_operation_check to allow access_log_review.finding while retaining all prior operations.
-- contract-of: 20261121040000000
SET LOCAL lock_timeout = '2s';
ALTER TABLE api_idempotency_keys
    DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check,
    ADD CONSTRAINT api_idempotency_keys_operation_check CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'hr.exit_case.bulk_create', 'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve', 'period_lock.unlock_reject',
        'employee.correction.bulk', 'appointment_notice.issue', 'tenant.domain.request', 'platform.tenant.rename',
        'certificate.issue', 'certificate.void', 'certificate.reissue',
        'platform.tenant.ops_recovery.open', 'platform.tenant.ops_recovery.approve',
        'platform.tenant.ops_recovery.issue', 'platform.tenant.ops_recovery.cancel',
        'employee_import.rollback', 'access_log_review.start', 'access_log_review.finding',
        'access_log_review.complete'
    )) NOT VALID;
ALTER TABLE api_idempotency_keys
    VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

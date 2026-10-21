-- Restore the refusal operation dropped when the tenant-domain allowlist was rebuilt.
SET LOCAL lock_timeout = '2s';

ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
        'period_lock.unlock_reject',
        'employee.correction.bulk', 'appointment_notice.issue',
        'tenant.domain.request', 'platform.tenant.rename'
    )) NOT VALID;
ALTER TABLE api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

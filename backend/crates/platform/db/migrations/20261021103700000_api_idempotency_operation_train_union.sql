-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: the release train landed two allow-lists for this CHECK. Certificate
-- commands (20261021001539617) and ops recovery (20261021002934225) each rebuilt it from
-- the same base, so the later one dropped certificate.issue/void/reissue. This keeps both.
SET LOCAL lock_timeout = '2s';
ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check CHECK (operation IN (
    'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
    'employee.lifecycle.bulk',
    'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
    'period_lock.unlock_reject',
    'employee.correction.bulk', 'appointment_notice.issue',
    'tenant.domain.request', 'platform.tenant.rename',
    'certificate.issue', 'certificate.void', 'certificate.reissue',
    'platform.tenant.ops_recovery.open', 'platform.tenant.ops_recovery.approve',
    'platform.tenant.ops_recovery.issue', 'platform.tenant.ops_recovery.cancel'
)) NOT VALID;
ALTER TABLE api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

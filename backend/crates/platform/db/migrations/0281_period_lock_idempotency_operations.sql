-- BW-15 (LOCK lane): Idempotency-Key on period lock, unlock and unlock
-- approval. The reservation table only admits listed operations (0243, 0245),
-- so the three period-lock operations join the list. Numbered head+1 of the
-- lane's base; INTEG renumbers and, when another lane widens the same CHECK,
-- keeps the union in the later migration.
SET LOCAL lock_timeout = '2s';

ALTER TABLE api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve'
    ));

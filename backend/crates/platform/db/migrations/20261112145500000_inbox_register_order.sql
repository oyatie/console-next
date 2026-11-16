-- no-transaction
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Keep person revision hydration behind the register source's keyset LIMIT.
CREATE INDEX CONCURRENTLY employees_org_register_inbox_order_idx
    ON employees (org_id, created_at, ('hr_register:' || id::text))
    WHERE (employment_status <> 'VOIDED');

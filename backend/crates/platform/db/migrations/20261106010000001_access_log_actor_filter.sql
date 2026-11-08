-- no-transaction
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Exact access-log filters retain tenant-local keyset order.
CREATE INDEX CONCURRENTLY idx_access_log_actor_page
    ON audit_events (org_id, actor, created_at, id)
    WHERE (after_snap ? 'self_read');

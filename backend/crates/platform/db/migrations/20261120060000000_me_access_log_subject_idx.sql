-- no-transaction
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Support subject-scoped access-log lookups without scanning all tenant audit events.
CREATE INDEX CONCURRENTLY idx_audit_events_subject_ids_gin
    ON audit_events USING GIN ((after_snap->'subject_ids'))
    WHERE (after_snap ? 'subject_ids');

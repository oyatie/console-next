-- no-transaction
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Support user-subject access-log lookups without scanning all tenant audit events.
CREATE INDEX CONCURRENTLY idx_audit_events_user_subject_ids_gin
    ON audit_events USING GIN ((after_snap->'user_subject_ids'))
    WHERE (after_snap ? 'user_subject_ids');

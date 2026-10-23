-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; released migrations are immutable.
-- Per-viewer reads, including the action inbox, depend on newly effective grants.
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('access_grant', 'access.grant.activated', 'tenant', false);

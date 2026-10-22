-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; released migrations are immutable.
-- Worker activation invalidates the same access reads as an interactive grant.
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('access_grant', 'access.grant.activated', 'role', false),
    ('access_grant', 'access.grant.activated', 'user', false);

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Add partial unique open-invite index and register platform_operator realtime topics.
SET LOCAL lock_timeout = '2s';
CREATE UNIQUE INDEX platform_operator_invites_one_open_idx
    ON platform_operator_invites (user_id)
    WHERE (accepted_at IS NULL AND revoked_at IS NULL);
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('platform_operator', 'platform.operator.invite', 'platform_operator', true),
    ('platform_operator', 'platform.operator.reissue', 'platform_operator', true),
    ('platform_operator', 'platform.operator.revoke', 'platform_operator', true)
ON CONFLICT DO NOTHING;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Notify open tenant sessions after a committed appearance change.
SET LOCAL lock_timeout = '2s';

INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('org_runtime_flag', 'console.kill_switch', 'console_rollout', false),
    ('org_runtime_flag', 'console.org_flag_update', 'console_rollout', false),
    ('user', 'user.workspace_update', 'workspace', true),
    ('tenant_setting_override', 'settings.override_insert', 'tenant_settings', false)
ON CONFLICT DO NOTHING;

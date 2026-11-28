-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Register tenant rollback and saved appearance changes in the existing realtime topic map.
SET LOCAL lock_timeout = '2s';

INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('org_runtime_flag', 'console.kill_switch', 'console_rollout', false),
    ('org_runtime_flag', 'console.org_flag_update', 'console_rollout', false),
    ('user', 'user.workspace_update', 'workspace', true),
    ('tenant_setting_override', 'settings.override_insert', 'tenant_settings', false)
ON CONFLICT DO NOTHING;

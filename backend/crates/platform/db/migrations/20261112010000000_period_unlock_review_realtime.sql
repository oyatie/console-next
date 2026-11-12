-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- The receipt names an exception, so refresh lock lists without publishing its id as a lock id.
SET LOCAL lock_timeout = '2s';
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id)
VALUES ('governed_exception', 'exception.review', 'period_lock', false)
ON CONFLICT DO NOTHING;

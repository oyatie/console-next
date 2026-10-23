-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: request, second-person decision and controller sign-off share one read door.
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('governed_exception', 'exception.request', 'identifier_correction', true),
    ('governed_exception', 'exception.decide', 'identifier_correction', true),
    ('governed_exception', 'exception.review', 'identifier_correction', true);

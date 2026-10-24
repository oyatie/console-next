-- SPDX-License-Identifier: LicenseRef-Proprietary
-- These account tasks are visible to their holder even without user/role administration.
SET LOCAL lock_timeout = '2s';
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('auth_webauthn_credential', 'auth.passkey.register', 'inbox', false),
    ('auth_webauthn_credential', 'auth.passkey.revoke', 'inbox', false),
    ('access_grants', 'access.grant.notice', 'inbox', false),
    ('access_grant_receipts', 'access.grants.apply', 'inbox', false);

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Register missing keys in existing reference data without changing permissions.
-- Register the Cedar-only privacy request features without assigning permissions.
SET LOCAL lock_timeout = '2s';

INSERT INTO feature_catalog (feature_key) VALUES
    ('privacy_request_file'),
    ('privacy_request_decide')
ON CONFLICT (feature_key) DO NOTHING;

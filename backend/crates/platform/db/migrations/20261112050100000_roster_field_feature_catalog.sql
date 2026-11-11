-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Register one missing key in existing reference data without changing permissions.
-- Makes the Cedar-only roster field definition grant grantable; grants nobody.
SET LOCAL lock_timeout = '2s';

INSERT INTO feature_catalog (feature_key) VALUES ('roster_field_manage')
ON CONFLICT (feature_key) DO NOTHING;

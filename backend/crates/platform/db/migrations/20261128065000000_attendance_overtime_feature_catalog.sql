-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — register the overtime decision feature in existing reference data.
SET LOCAL lock_timeout = '2s';

INSERT INTO feature_catalog (feature_key) VALUES ('attendance_overtime_decide')
ON CONFLICT (feature_key) DO NOTHING;

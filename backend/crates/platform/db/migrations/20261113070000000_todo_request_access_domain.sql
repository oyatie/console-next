-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Accept the todo_request domain on role lines and register its key; grants nobody.
-- contract-of: 20261023100000000
SET LOCAL lock_timeout = '2s';
ALTER TABLE access_role_lines DROP CONSTRAINT access_role_lines_domain_check;
ALTER TABLE access_role_lines ADD CONSTRAINT access_role_lines_domain_check CHECK (domain IN ('org','hr_basic','appointment','exit','attendance','pay','bank','evaluation','discipline','sensitive','documents','notice','access','audit','settings','exceptions','retention','tenant','support_access','todo_request')) NOT VALID;
ALTER TABLE access_role_lines VALIDATE CONSTRAINT access_role_lines_domain_check;
INSERT INTO feature_catalog (feature_key) VALUES ('todo_assign') ON CONFLICT (feature_key) DO NOTHING;

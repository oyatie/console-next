-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — replace the fixed enrollment keys with a validated foreign key.
-- contract-of: 20261128062100000
SET LOCAL lock_timeout = '2s';

CREATE TABLE release_modules (
    module_key TEXT PRIMARY KEY,
    setting_key TEXT GENERATED ALWAYS AS ('module.' || module_key || '.enabled') STORED
        REFERENCES setting_definitions(key)
);
REVOKE ALL ON release_modules FROM PUBLIC, console_rt;
COMMENT ON COLUMN release_modules.module_key IS 'pd:none — supported release module identifier';
COMMENT ON COLUMN release_modules.setting_key IS 'pd:none — registered tenant opt-out setting';

INSERT INTO release_modules (module_key) VALUES ('benefits'), ('calendar'), ('evaluation');

ALTER TABLE tenant_module_enrollments ADD CONSTRAINT tenant_module_enrollments_release_key
    FOREIGN KEY (module_key) REFERENCES release_modules(module_key) NOT VALID;
ALTER TABLE tenant_module_enrollments VALIDATE CONSTRAINT tenant_module_enrollments_release_key;
ALTER TABLE tenant_module_enrollments DROP CONSTRAINT tenant_module_enrollments_module_key_check;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_rrn
    ADD COLUMN rrn_hmac_v2 BYTEA CHECK (rrn_hmac_v2 IS NULL OR (octet_length(rrn_hmac_v2) = 32));
ALTER TABLE employee_rrn
    ADD COLUMN blind_index_version SMALLINT CHECK (blind_index_version IS NULL OR (blind_index_version >= 2));

ALTER TABLE data_import_row_identities
    ADD COLUMN rrn_hmac_v2 BYTEA CHECK (rrn_hmac_v2 IS NULL OR (octet_length(rrn_hmac_v2) = 32));
ALTER TABLE data_import_row_identities
    ADD COLUMN blind_index_version SMALLINT CHECK (blind_index_version IS NULL OR (blind_index_version >= 2));

GRANT UPDATE (rrn_hmac_v2, blind_index_version) ON employee_rrn TO console_rt;

COMMENT ON COLUMN employee_rrn.rrn_hmac_v2 IS 'pd:unique-id/rrn — tenant-bound HMAC-SHA256 blind index v2 (HKDF-SHA256 domain-separated by org_id, table, field, version)';
COMMENT ON COLUMN employee_rrn.blind_index_version IS 'pd:none — tenant-bound blind index derivation version (>= 2)';
COMMENT ON COLUMN data_import_row_identities.rrn_hmac_v2 IS 'pd:unique-id/rrn — staged tenant-bound HMAC-SHA256 blind index v2';
COMMENT ON COLUMN data_import_row_identities.blind_index_version IS 'pd:none — staged tenant-bound blind index derivation version (>= 2)';

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Replace nonce-only checks with versioned shapes while retaining v1 writes.
-- contract-of: 0296
-- SMTP and IMAP can be replaced independently during an envelope upgrade.
ALTER TABLE email_accounts ADD COLUMN imap_key_version SMALLINT;
UPDATE email_accounts SET imap_key_version = key_version;
ALTER TABLE email_accounts ALTER COLUMN imap_key_version SET DEFAULT 1;
ALTER TABLE email_accounts ALTER COLUMN imap_key_version SET NOT NULL;
COMMENT ON COLUMN email_accounts.imap_key_version IS 'pd:none — IMAP credential envelope suite';

-- Accept legacy XChaCha envelopes and nonce-free AES-KWP wraps of AES-GCM DEKs.
ALTER TABLE employee_rrn
    DROP CONSTRAINT employee_rrn_nonce_check,
    DROP CONSTRAINT employee_rrn_dek_nonce_check,
    ADD CONSTRAINT employee_rrn_envelope_shape CHECK (
        (key_version = 1 AND octet_length(nonce) = 24 AND octet_length(dek_nonce) = 24)
        OR (key_version = 2 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40));
ALTER TABLE data_import_row_identities
    DROP CONSTRAINT data_import_row_identities_nonce_check,
    DROP CONSTRAINT data_import_row_identities_dek_nonce_check,
    ADD CONSTRAINT data_import_row_identities_envelope_shape CHECK (
        (key_version = 1 AND octet_length(nonce) = 24 AND octet_length(dek_nonce) = 24)
        OR (key_version = 2 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40));

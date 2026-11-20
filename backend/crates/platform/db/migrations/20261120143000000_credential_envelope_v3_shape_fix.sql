-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce NOT NULL on v3 envelope fields across RRN and webmail tables using explicit IS TRUE guards.
-- contract-of: 20261120090000000
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_rrn
    DROP CONSTRAINT IF EXISTS employee_rrn_envelope_shape,
    ADD CONSTRAINT employee_rrn_envelope_shape CHECK ((
        (key_version = 1 AND octet_length(nonce) = 24 AND octet_length(dek_nonce) = 24)
        OR (key_version = 2 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40)
        OR (key_version = 3
            AND octet_length(nonce) = 12
            AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40
            AND msg_id IS NOT NULL AND octet_length(msg_id) = 32
            AND commitment_tag IS NOT NULL AND octet_length(commitment_tag) = 32
            AND kek_id IS NOT NULL
            AND alg_id IS NOT NULL
            AND alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp')
    ) IS TRUE) NOT VALID;
ALTER TABLE employee_rrn
    VALIDATE CONSTRAINT employee_rrn_envelope_shape;

ALTER TABLE data_import_row_identities
    DROP CONSTRAINT IF EXISTS data_import_row_identities_envelope_shape,
    ADD CONSTRAINT data_import_row_identities_envelope_shape CHECK ((
        (key_version = 1 AND octet_length(nonce) = 24 AND octet_length(dek_nonce) = 24)
        OR (key_version = 2 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40)
        OR (key_version = 3
            AND octet_length(nonce) = 12
            AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40
            AND msg_id IS NOT NULL AND octet_length(msg_id) = 32
            AND commitment_tag IS NOT NULL AND octet_length(commitment_tag) = 32
            AND kek_id IS NOT NULL
            AND alg_id IS NOT NULL
            AND alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp')
    ) IS TRUE) NOT VALID;
ALTER TABLE data_import_row_identities
    VALIDATE CONSTRAINT data_import_row_identities_envelope_shape;

ALTER TABLE email_accounts
    DROP CONSTRAINT IF EXISTS email_accounts_smtp_envelope_shape,
    DROP CONSTRAINT IF EXISTS email_accounts_imap_envelope_shape,
    ADD CONSTRAINT email_accounts_smtp_envelope_shape CHECK ((
        key_version IN (1, 2)
        OR (key_version = 3
            AND octet_length(smtp_password_nonce) = 12
            AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40
            AND smtp_msg_id IS NOT NULL AND octet_length(smtp_msg_id) = 32
            AND smtp_commitment_tag IS NOT NULL AND octet_length(smtp_commitment_tag) = 32
            AND kek_id IS NOT NULL
            AND alg_id IS NOT NULL
            AND alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp')
    ) IS TRUE) NOT VALID,
    ADD CONSTRAINT email_accounts_imap_envelope_shape CHECK ((
        imap_key_version IN (1, 2)
        OR (imap_key_version = 3
            AND octet_length(imap_password_nonce) = 12
            AND octet_length(imap_dek_nonce) = 0
            AND octet_length(imap_dek_wrapped) = 40
            AND imap_msg_id IS NOT NULL AND octet_length(imap_msg_id) = 32
            AND imap_commitment_tag IS NOT NULL AND octet_length(imap_commitment_tag) = 32
            AND imap_kek_id IS NOT NULL
            AND imap_alg_id IS NOT NULL
            AND imap_alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp')
    ) IS TRUE) NOT VALID;
ALTER TABLE email_accounts
    VALIDATE CONSTRAINT email_accounts_smtp_envelope_shape;
ALTER TABLE email_accounts
    VALIDATE CONSTRAINT email_accounts_imap_envelope_shape;

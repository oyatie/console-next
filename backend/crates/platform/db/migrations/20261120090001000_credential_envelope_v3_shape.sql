-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Widen RRN envelope shape checks for key_version 3 AWS-ESDK-v2 while retaining v1 writes.
-- contract-of: 20261120090000000
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_rrn
    DROP CONSTRAINT employee_rrn_envelope_shape,
    ADD CONSTRAINT employee_rrn_envelope_shape CHECK (
        (key_version = 1 AND octet_length(nonce) = 24 AND octet_length(dek_nonce) = 24)
        OR (key_version = 2 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40)
        OR (key_version = 3 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40 AND octet_length(msg_id) = 32
            AND octet_length(commitment_tag) = 32 AND kek_id IS NOT NULL AND alg_id IS NOT NULL));

ALTER TABLE data_import_row_identities
    DROP CONSTRAINT data_import_row_identities_envelope_shape,
    ADD CONSTRAINT data_import_row_identities_envelope_shape CHECK (
        (key_version = 1 AND octet_length(nonce) = 24 AND octet_length(dek_nonce) = 24)
        OR (key_version = 2 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40)
        OR (key_version = 3 AND octet_length(nonce) = 12 AND octet_length(dek_nonce) = 0
            AND octet_length(dek_wrapped) = 40 AND octet_length(msg_id) = 32
            AND octet_length(commitment_tag) = 32 AND kek_id IS NOT NULL AND alg_id IS NOT NULL));

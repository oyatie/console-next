-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

GRANT UPDATE (ciphertext, nonce, dek_wrapped, dek_nonce, key_version, alg_id, kek_id, msg_id, commitment_tag)
    ON employee_rrn TO console_rt;
GRANT UPDATE (ciphertext, nonce, dek_wrapped, dek_nonce, key_version, alg_id, kek_id, msg_id, commitment_tag)
    ON data_import_row_identities TO console_rt;

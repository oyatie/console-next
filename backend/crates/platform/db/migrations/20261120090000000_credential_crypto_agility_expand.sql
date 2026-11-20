-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

ALTER TABLE email_accounts
    ADD COLUMN alg_id TEXT CHECK (alg_id IS NULL OR (char_length(btrim(alg_id)) BETWEEN 1 AND 64));
ALTER TABLE email_accounts
    ADD COLUMN kek_id TEXT CHECK (kek_id IS NULL OR (char_length(btrim(kek_id)) BETWEEN 1 AND 128));
ALTER TABLE email_accounts
    ADD COLUMN smtp_msg_id BYTEA CHECK (smtp_msg_id IS NULL OR (octet_length(smtp_msg_id) = 32));
ALTER TABLE email_accounts
    ADD COLUMN smtp_commitment_tag BYTEA CHECK (smtp_commitment_tag IS NULL OR (octet_length(smtp_commitment_tag) = 32));
ALTER TABLE email_accounts
    ADD COLUMN imap_alg_id TEXT CHECK (imap_alg_id IS NULL OR (char_length(btrim(imap_alg_id)) BETWEEN 1 AND 64));
ALTER TABLE email_accounts
    ADD COLUMN imap_kek_id TEXT CHECK (imap_kek_id IS NULL OR (char_length(btrim(imap_kek_id)) BETWEEN 1 AND 128));
ALTER TABLE email_accounts
    ADD COLUMN imap_msg_id BYTEA CHECK (imap_msg_id IS NULL OR (octet_length(imap_msg_id) = 32));
ALTER TABLE email_accounts
    ADD COLUMN imap_commitment_tag BYTEA CHECK (imap_commitment_tag IS NULL OR (octet_length(imap_commitment_tag) = 32));

ALTER TABLE employee_rrn
    ADD COLUMN alg_id TEXT CHECK (alg_id IS NULL OR (char_length(btrim(alg_id)) BETWEEN 1 AND 64));
ALTER TABLE employee_rrn
    ADD COLUMN kek_id TEXT CHECK (kek_id IS NULL OR (char_length(btrim(kek_id)) BETWEEN 1 AND 128));
ALTER TABLE employee_rrn
    ADD COLUMN msg_id BYTEA CHECK (msg_id IS NULL OR (octet_length(msg_id) = 32));
ALTER TABLE employee_rrn
    ADD COLUMN commitment_tag BYTEA CHECK (commitment_tag IS NULL OR (octet_length(commitment_tag) = 32));

ALTER TABLE data_import_row_identities
    ADD COLUMN alg_id TEXT CHECK (alg_id IS NULL OR (char_length(btrim(alg_id)) BETWEEN 1 AND 64));
ALTER TABLE data_import_row_identities
    ADD COLUMN kek_id TEXT CHECK (kek_id IS NULL OR (char_length(btrim(kek_id)) BETWEEN 1 AND 128));
ALTER TABLE data_import_row_identities
    ADD COLUMN msg_id BYTEA CHECK (msg_id IS NULL OR (octet_length(msg_id) = 32));
ALTER TABLE data_import_row_identities
    ADD COLUMN commitment_tag BYTEA CHECK (commitment_tag IS NULL OR (octet_length(commitment_tag) = 32));

COMMENT ON COLUMN email_accounts.alg_id IS 'pd:none — SMTP credential envelope algorithm suite identifier';
COMMENT ON COLUMN email_accounts.kek_id IS 'pd:none — SMTP credential wrapping KEK identifier';
COMMENT ON COLUMN email_accounts.smtp_msg_id IS 'pd:none — SMTP credential AWS-ESDK-v2 32-byte per-message HKDF salt';
COMMENT ON COLUMN email_accounts.smtp_commitment_tag IS 'pd:none — SMTP credential AWS-ESDK-v2 256-bit key commitment tag';
COMMENT ON COLUMN email_accounts.imap_alg_id IS 'pd:none — IMAP credential envelope algorithm suite identifier';
COMMENT ON COLUMN email_accounts.imap_kek_id IS 'pd:none — IMAP credential wrapping KEK identifier';
COMMENT ON COLUMN email_accounts.imap_msg_id IS 'pd:none — IMAP credential AWS-ESDK-v2 32-byte per-message HKDF salt';
COMMENT ON COLUMN email_accounts.imap_commitment_tag IS 'pd:none — IMAP credential AWS-ESDK-v2 256-bit key commitment tag';

COMMENT ON COLUMN employee_rrn.alg_id IS 'pd:none — RRN envelope algorithm suite identifier';
COMMENT ON COLUMN employee_rrn.kek_id IS 'pd:none — RRN wrapping KEK identifier';
COMMENT ON COLUMN employee_rrn.msg_id IS 'pd:none — RRN AWS-ESDK-v2 32-byte per-message HKDF salt';
COMMENT ON COLUMN employee_rrn.commitment_tag IS 'pd:none — RRN AWS-ESDK-v2 256-bit key commitment tag';

COMMENT ON COLUMN data_import_row_identities.alg_id IS 'pd:none — staged RRN envelope algorithm suite identifier';
COMMENT ON COLUMN data_import_row_identities.kek_id IS 'pd:none — staged RRN wrapping KEK identifier';
COMMENT ON COLUMN data_import_row_identities.msg_id IS 'pd:none — staged RRN AWS-ESDK-v2 32-byte per-message HKDF salt';
COMMENT ON COLUMN data_import_row_identities.commitment_tag IS 'pd:none — staged RRN AWS-ESDK-v2 256-bit key commitment tag';

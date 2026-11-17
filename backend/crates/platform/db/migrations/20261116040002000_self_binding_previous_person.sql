-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Preserve the original identity for self-attestation withdrawal.
SET LOCAL lock_timeout = '2s';
ALTER TABLE account_link_self_attestations ADD COLUMN previous_person_id UUID;
COMMENT ON COLUMN account_link_self_attestations.previous_person_id IS 'pd:personal — account identity before self-attestation; null for older receipts';

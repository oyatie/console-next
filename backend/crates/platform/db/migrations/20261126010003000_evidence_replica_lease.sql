-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';
ALTER TABLE evidence_media ADD COLUMN replica_lease_until TIMESTAMPTZ;
COMMENT ON COLUMN evidence_media.replica_lease_until IS 'pd:none — expiry and ownership fence for a replica write';

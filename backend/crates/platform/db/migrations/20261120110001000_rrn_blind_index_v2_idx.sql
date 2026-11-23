-- no-transaction
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
CREATE INDEX CONCURRENTLY employee_rrn_hmac_v2_idx
    ON employee_rrn (org_id, rrn_hmac_v2)
    WHERE (rrn_hmac_v2 IS NOT NULL);

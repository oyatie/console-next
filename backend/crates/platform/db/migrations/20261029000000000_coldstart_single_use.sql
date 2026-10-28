-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Upgrade every previously seeded code, including when the boot secret changed
-- or was removed. Accepted legacy redemptions remain used across the rollout.
SET LOCAL lock_timeout = '2s';
-- The migration owner needs historical platform audits whose org_id is NULL.
-- Keep runtime RLS enabled and restore owner enforcement in this transaction.
ALTER TABLE auth_bootstrap_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;

UPDATE auth_bootstrap_credentials c
SET single_use = true,
    redeemed_at = COALESCE(c.redeemed_at, (
        SELECT min(a.occurred_at)
        FROM audit_events a
        WHERE a.actor = c.user_id
          AND a.target_type = 'auth_bootstrap_credential'
          AND a.target_id = c.id::text
          AND a.action = 'auth.otp.redeem'
    ))
WHERE c.issuance_version = 0
  AND NOT c.single_use
  AND EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.actor = c.user_id
        AND a.target_type = 'auth_bootstrap_credential'
        AND a.target_id = c.id::text
        AND a.action = 'auth.coldstart.seed'
  );

ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_bootstrap_credentials FORCE ROW LEVEL SECURITY;

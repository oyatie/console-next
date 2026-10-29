-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Preserve every accepted legacy redemption when all code kinds start claiming
-- redeemed_at. Keep enrollment sources/families open for their winning session.
SET LOCAL lock_timeout = '2s';
ALTER TABLE auth_bootstrap_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;

UPDATE auth_bootstrap_credentials c
SET redeemed_at = (
    SELECT min(a.occurred_at)
    FROM audit_events a
    WHERE a.actor = c.user_id
      AND a.target_type = 'auth_bootstrap_credential'
      AND a.target_id = c.id::text
      AND a.action = 'auth.otp.redeem'
)
WHERE c.issuance_version = 0
  AND c.redeemed_at IS NULL
  AND EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.actor = c.user_id
        AND a.target_type = 'auth_bootstrap_credential'
        AND a.target_id = c.id::text
        AND a.action = 'auth.otp.redeem'
  );

ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_bootstrap_credentials FORCE ROW LEVEL SECURITY;

-- Served lifecycle facts count only codes that can still redeem.
CREATE OR REPLACE FUNCTION platform_tenant_facts(p_id UUID)
RETURNS TABLE(removable BOOLEAN, removal_refusal TEXT, lifecycle TEXT, code_issued_count BIGINT, passkey_registered_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$
 WITH facts AS (
 SELECT
 EXISTS(SELECT 1 FROM docs_evidence_legal_holds WHERE org_id=p_id AND status='ACTIVE') held,
 platform_tenant_has_data(p_id) has_data,
 platform_tenant_admin_enrolled(p_id) enrolled,
 EXISTS(SELECT 1 FROM tenant_phase WHERE org_id=p_id AND go_live_at IS NOT NULL) operating,
 EXISTS(SELECT 1 FROM tenant_phase WHERE org_id=p_id) setup,
 (SELECT count(*) FROM person_accounts_current u WHERE u.org_id=p_id AND u.is_active
  AND EXISTS(SELECT 1 FROM auth_bootstrap_credentials c WHERE c.user_id=u.id AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>statement_timestamp() AND c.redeemed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id)) issued,
 (SELECT count(*) FROM person_accounts_current u WHERE u.org_id=p_id AND u.is_active
  AND EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id)) registered
 )
 SELECT NOT held AND NOT has_data,
 CASE WHEN held THEN 'blocked_legal_hold' WHEN has_data THEN 'tenant_has_data' END,
 CASE WHEN operating THEN 'OPERATING' WHEN enrolled AND setup THEN 'SETUP' WHEN enrolled THEN 'ENROLLED' WHEN issued>0 THEN 'CODE_ISSUED' ELSE 'OPENED' END,
 issued, registered FROM facts
$$;
REVOKE ALL ON FUNCTION platform_tenant_facts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_facts(UUID) TO console_rt;

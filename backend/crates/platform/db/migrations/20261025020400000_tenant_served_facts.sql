-- SPDX-License-Identifier: LicenseRef-Proprietary
-- One predicate for the served removal fact and the guarded command.
CREATE FUNCTION platform_tenant_has_data(p_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$
    SELECT
        EXISTS (SELECT 1 FROM legal_entities WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM employees WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM employment_heads WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM org_units WHERE org_id = p_id)
     OR EXISTS (
         SELECT 1 FROM person_revisions r WHERE r.org_id = p_id
         AND NOT (r.origin = 'binding' AND r.version = 1 AND EXISTS (
             SELECT 1 FROM users u WHERE u.org_id = r.org_id AND u.person_id = r.person_id
             AND u.is_tenant_ops AND u.employee_id IS NULL
         ))
     )
     OR EXISTS (SELECT 1 FROM docs_evidence_objects WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registry_equipment           WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM work_orders                   WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registry_sites               WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registry_customers           WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM inspection_rounds            WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM regular_inspection_schedules WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM sales_listings               WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM customer_inquiries           WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_rental_quotes      WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_purchase_requests  WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_purchase_attachments WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_regular_purchase_prices WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM financial_expense_ledger      WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM equipment_cost_ledger        WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM messenger_threads            WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM location_consents            WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM site_attendance_events       WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM governance_findings          WHERE org_id = p_id)
     OR EXISTS (SELECT 1 FROM registered_devices rd
                JOIN users u ON u.id = rd.user_id WHERE u.org_id = p_id)
;
$$;
REVOKE ALL ON FUNCTION platform_tenant_has_data(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform_remove_organization(p_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    sentinel_org CONSTANT UUID := '00000000-0000-0000-0000-00000000face'::uuid;
    org_exists   BOOLEAN;
    has_data     BOOLEAN;
BEGIN
    IF p_id = sentinel_org THEN
        RETURN 'not_found';
    END IF;

    SET LOCAL row_security = off;

    org_exists := platform_lock_organization_accounts_for_removal(p_id) IS NOT NULL;
    IF NOT org_exists THEN
        SET LOCAL row_security = on;
        RETURN 'not_found';
    END IF;

    IF EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id AND status = 'ACTIVE') THEN
        RETURN 'blocked_legal_hold';
    END IF;

    has_data := platform_tenant_has_data(p_id);

    IF has_data THEN
        SET LOCAL row_security = on;
        RETURN 'blocked_has_data';
    END IF;

    PERFORM auth_security.retire_company_accounts(p_id);

    DELETE FROM auth_refresh_tokens         WHERE org_id = p_id;
    DELETE FROM auth_refresh_token_families WHERE org_id = p_id;
    DELETE FROM auth_webauthn_credentials   WHERE org_id = p_id;
    DELETE FROM auth_webauthn_ceremonies
        WHERE user_id IN (SELECT id FROM users WHERE org_id = p_id);
    DELETE FROM auth_bootstrap_credentials  WHERE org_id = p_id;

    DELETE FROM user_branches WHERE org_id = p_id;

    PERFORM set_config('app.audit_rehome', 'on', true);
    UPDATE audit_events
    SET org_id    = sentinel_org,
        actor     = NULL,
        branch_id = NULL
    WHERE org_id = p_id;
    PERFORM set_config('app.audit_rehome', 'off', true);

    DELETE FROM users    WHERE org_id = p_id;
    DELETE FROM branches WHERE org_id = p_id;
    DELETE FROM regions  WHERE org_id = p_id;

    DELETE FROM organizations WHERE id = p_id;

    SET LOCAL row_security = on;
    RETURN 'removed';
END;
$$;

REVOKE ALL ON FUNCTION platform_remove_organization(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_remove_organization(UUID) TO console_rt;


-- Evergreen enrollment evidence is shared by reissue and lifecycle reads.
CREATE FUNCTION platform_tenant_admin_enrolled(p_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$
 SELECT EXISTS (SELECT 1 FROM person_accounts_current u
 WHERE u.org_id=p_id AND 'SUPER_ADMIN'=ANY(u.roles) AND (
   EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id)
   OR EXISTS(SELECT 1 FROM audit_events a WHERE a.org_id=p_id AND a.action='auth.passkey.register' AND a.actor=u.id)))
$$;
REVOKE ALL ON FUNCTION platform_tenant_admin_enrolled(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_admin_enrolled(UUID) TO console_rt;

CREATE FUNCTION platform_tenant_facts(p_id UUID)
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
  AND EXISTS(SELECT 1 FROM auth_bootstrap_credentials c WHERE c.user_id=u.id AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>statement_timestamp() AND (NOT c.single_use OR c.redeemed_at IS NULL))
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

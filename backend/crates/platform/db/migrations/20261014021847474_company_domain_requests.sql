-- CX-tenant-domain: tenant ops requests reach the platform operator's existing tenant panel.
SET LOCAL lock_timeout = '2s';
-- console-gate: audited-table organization_domain_requests
CREATE TABLE organization_domain_requests (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
    requested_by UUID NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    FOREIGN KEY (requested_by, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE
);
ALTER TABLE organization_domain_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_domain_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organization_domain_requests
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON organization_domain_requests FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON organization_domain_requests TO console_rt;
COMMENT ON TABLE organization_domain_requests IS 'Audited with tenant.domain.request; only tenant ops requests; platform reads with tenant listing';
COMMENT ON COLUMN organization_domain_requests.org_id IS 'pd:none — requesting tenant';
COMMENT ON COLUMN organization_domain_requests.slug IS 'pd:none — requested company domain';
COMMENT ON COLUMN organization_domain_requests.requested_by IS 'pd:personal — requesting account';
COMMENT ON COLUMN organization_domain_requests.requested_at IS 'pd:none — request timestamp';
COMMENT ON COLUMN organization_domain_requests.resolved_at IS 'pd:none — fulfilled by platform rename';
CREATE FUNCTION platform_organization_pending_domain(p_org UUID) RETURNS TEXT
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$ SELECT slug FROM organization_domain_requests WHERE org_id=p_org AND resolved_at IS NULL $$;
REVOKE ALL ON FUNCTION platform_organization_pending_domain(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_organization_pending_domain(UUID) TO console_rt;

-- Expand the existing endpoint discriminator; all N-1 operations remain valid.
ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
        'employee.correction.bulk', 'appointment_notice.issue',
        'tenant.domain.request', 'platform.tenant.rename'
    )) NOT VALID;
ALTER TABLE api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_operation_check;

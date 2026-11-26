-- migration-class: expand
-- Erasure ledger sequence numbers are scoped to each erased tenant.
-- A committed emission receipt identifies the immutable platform erase request.
CREATE TABLE tenant_erase_witness_emissions (
    request_id UUID PRIMARY KEY REFERENCES tenant_erase_requests(id),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
        CHECK (org_id = '00000000-0000-0000-0000-00000000face'::uuid),
    emitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE tenant_erase_witness_emissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_erase_witness_emissions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_erase_witness_emissions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM tenant_erase_requests r
             WHERE r.id = request_id AND r.org_id = tenant_erase_witness_emissions.org_id
               AND r.erased_at IS NOT NULL AND r.erasure_witness_hash IS NOT NULL
        )
    );
REVOKE ALL ON tenant_erase_witness_emissions FROM PUBLIC, console_rt, console_platform_force_cmd;
GRANT SELECT, INSERT (request_id, org_id) ON tenant_erase_witness_emissions TO console_rt;
COMMENT ON TABLE tenant_erase_witness_emissions IS 'Platform worker acknowledgements for structured witness log emission; external log retention is independent.';
COMMENT ON COLUMN tenant_erase_witness_emissions.request_id IS 'pd:none — immutable erase request identifier';
COMMENT ON COLUMN tenant_erase_witness_emissions.org_id IS 'pd:none — platform sentinel owner';
COMMENT ON COLUMN tenant_erase_witness_emissions.emitted_at IS 'pd:none — witness log emission time';

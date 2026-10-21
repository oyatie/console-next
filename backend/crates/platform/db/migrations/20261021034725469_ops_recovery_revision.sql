-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; stamped by tools/lanes/new-migration.py.
SET LOCAL lock_timeout = '2s';

-- Both evidence fields use the same normalized detector, including pasted separators.
CREATE FUNCTION ops_recovery_contains_rrn(value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT regexp_replace(normalize(value,NFKC),'[[:space:]]','','g') ~ '[0-9]{6}[^0-9]{0,3}[1-8][0-9]{6}' $$;
ALTER TABLE ops_recovery_requests
    DROP CONSTRAINT ops_recovery_evidence_identifier,
    DROP CONSTRAINT ops_recovery_name_identifier,
    ADD CONSTRAINT ops_recovery_evidence_identifier CHECK (NOT ops_recovery_contains_rrn(evidence_ref)) NOT VALID,
    ADD CONSTRAINT ops_recovery_name_identifier CHECK (NOT ops_recovery_contains_rrn(authoriser_name)) NOT VALID;
ALTER TABLE ops_recovery_requests VALIDATE CONSTRAINT ops_recovery_evidence_identifier;
ALTER TABLE ops_recovery_requests VALIDATE CONSTRAINT ops_recovery_name_identifier;

-- Recovery redemption is auth custody; console_auth_cmd needs no business-table grant.
ALTER TABLE auth_bootstrap_credentials ADD COLUMN single_use BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN redeemed_at TIMESTAMPTZ;
COMMENT ON COLUMN auth_bootstrap_credentials.single_use IS 'pd:none — allow only one redemption before enrollment';
COMMENT ON COLUMN auth_bootstrap_credentials.redeemed_at IS 'pd:personal — single-use credential redemption time; consumed_at remains the enrollment source';
UPDATE auth_bootstrap_credentials c SET single_use=true, redeemed_at=r.code_redeemed_at
FROM ops_recovery_requests r WHERE c.id=r.code_credential_id AND c.org_id=r.org_id;
-- code_redeemed_at is now legacy: auth_bootstrap_credentials.redeemed_at owns redemption.

INSERT INTO realtime_topic_map(target_type,action,resource_type,carries_id) VALUES
    ('ops_recovery_request','platform.tenant.ops_recovery.open','ops_recovery',true),
    ('ops_recovery_request','platform.tenant.ops_recovery.approve','ops_recovery',true),
    ('ops_recovery_request','platform.tenant.ops_recovery.cancel','ops_recovery',true),
    ('ops_recovery_request','platform.tenant.ops_recovery.issue','ops_recovery',true);

-- Mirror only recovery hints to the requester's platform org; no evidence leaves the read API.
CREATE FUNCTION ops_recovery_platform_hint() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE vendor_org UUID;
BEGIN
    IF NEW.resource_type <> 'ops_recovery' THEN RETURN NULL; END IF;
    SELECT u.org_id INTO vendor_org FROM ops_recovery_requests r JOIN users u ON u.id=r.requested_by
    WHERE r.org_id=NEW.org_id AND r.id::text=NEW.resource_id AND u.org_id<>NEW.org_id;
    IF vendor_org IS NOT NULL THEN
        INSERT INTO resource_changes(org_id,audit_event_id,resource_type,resource_id)
        VALUES(vendor_org,NEW.audit_event_id,NEW.resource_type,NEW.resource_id);
        PERFORM pg_notify('resource_changed',json_build_object('org',vendor_org,'tx',pg_current_xact_id()::text)::text);
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION ops_recovery_platform_hint() FROM PUBLIC;
CREATE TRIGGER ops_recovery_platform_hint AFTER INSERT ON resource_changes
FOR EACH ROW EXECUTE FUNCTION ops_recovery_platform_hint();

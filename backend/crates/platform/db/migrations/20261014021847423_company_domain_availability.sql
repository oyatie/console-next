-- CX-tenant-domain: platform-only live availability includes permanent reservations.
SET LOCAL lock_timeout = '2s';
CREATE FUNCTION platform_company_domain_available(p_slug TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$ SELECT NOT EXISTS (SELECT 1 FROM organization_domains WHERE slug = p_slug) $$;
REVOKE ALL ON FUNCTION platform_company_domain_available(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_company_domain_available(TEXT) TO console_rt;

-- Reserve only rows actually inserted: ON CONFLICT must remain side-effect free.
DROP TRIGGER trg_organization_domains_reserve ON organizations;
CREATE TRIGGER trg_organization_domains_insert AFTER INSERT ON organizations
    FOR EACH ROW EXECUTE FUNCTION organization_domains_reserve();
CREATE TRIGGER trg_organization_domains_rename BEFORE UPDATE OF slug ON organizations
    FOR EACH ROW EXECUTE FUNCTION organization_domains_reserve();

-- CX-tenant-domain: permanent company-domain reservations, including after tenant removal.
-- Expand-only. N-1 may still rename display names; unsafe domain changes fail closed.
SET LOCAL lock_timeout = '2s';

-- console-gate: audited-table organization_domains
CREATE TABLE organization_domains (
    slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
    org_id UUID NOT NULL,
    retired_at TIMESTAMPTZ,
    alias_until TIMESTAMPTZ,
    CHECK ((retired_at IS NULL) = (alias_until IS NULL)),
    CHECK (alias_until IS NULL OR alias_until > retired_at)
);
-- No organization FK: deleting a tenant must never release its domains.
CREATE INDEX organization_domains_org_idx ON organization_domains (org_id);
INSERT INTO organization_domains (slug, org_id) SELECT slug, id FROM organizations;
ALTER TABLE organization_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organization_domains
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON organization_domains FROM PUBLIC, console_rt;
GRANT SELECT ON organization_domains TO console_rt;
COMMENT ON TABLE organization_domains IS 'Permanent company-domain reservations; audited with platform.tenant.rename; survive tenant removal';
COMMENT ON COLUMN organization_domains.slug IS 'pd:none — company domain reservation';
COMMENT ON COLUMN organization_domains.org_id IS 'pd:none — original tenant UUID, retained after removal';
COMMENT ON COLUMN organization_domains.retired_at IS 'pd:none — domain replacement timestamp';
COMMENT ON COLUMN organization_domains.alias_until IS 'pd:none — sign-in grace deadline, reservation never expires';

CREATE FUNCTION organization_domains_reserve() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.slug IS DISTINCT FROM OLD.slug THEN
        IF TG_OP = 'UPDATE' AND EXISTS (
            SELECT 1 FROM organization_domains WHERE slug = OLD.slug AND retired_at IS NULL
        ) THEN
            RAISE EXCEPTION 'domain retirement is required' USING ERRCODE = '23514';
        END IF;
        INSERT INTO organization_domains (slug, org_id) VALUES (NEW.slug, NEW.id);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION organization_domains_reserve() FROM PUBLIC;
CREATE TRIGGER trg_organization_domains_reserve BEFORE INSERT OR UPDATE OF slug ON organizations
    FOR EACH ROW EXECUTE FUNCTION organization_domains_reserve();

CREATE FUNCTION platform_lock_organization(p_id UUID)
RETURNS TABLE (slug TEXT, name TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$ SELECT o.slug, o.name FROM organizations o WHERE o.id = p_id FOR UPDATE $$;
REVOKE ALL ON FUNCTION platform_lock_organization(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_lock_organization(UUID) TO console_rt;

CREATE FUNCTION platform_rename_organization(p_id UUID, p_slug TEXT, p_name TEXT,
                                             p_retired_at TIMESTAMPTZ, p_alias_until TIMESTAMPTZ)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$
DECLARE v_slug TEXT; v_id UUID;
BEGIN
    IF p_id = '00000000-0000-0000-0000-00000000face'::uuid THEN RETURN NULL; END IF;
    SELECT slug INTO v_slug FROM organizations WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF p_slug IS NOT NULL AND p_slug IS DISTINCT FROM v_slug THEN
        UPDATE organization_domains SET retired_at = p_retired_at, alias_until = p_alias_until
            WHERE slug = v_slug AND org_id = p_id AND retired_at IS NULL;
    END IF;
    UPDATE organizations SET slug = coalesce(p_slug, slug), name = coalesce(p_name, name), updated_at = now()
        WHERE id = p_id RETURNING id INTO v_id;
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION platform_rename_organization(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_rename_organization(UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO console_rt;

-- Existing clients cannot silently break sign-in IDs during rollback.
CREATE OR REPLACE FUNCTION platform_rename_organization(p_id UUID, p_slug TEXT, p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$
BEGIN
    IF p_slug IS NOT NULL AND EXISTS (SELECT 1 FROM organizations WHERE id = p_id AND slug <> p_slug) THEN
        RAISE EXCEPTION 'domain change requires alias deadline' USING ERRCODE = '23514';
    END IF;
    RETURN platform_rename_organization(p_id, p_slug, p_name, NULL, NULL);
END $$;

CREATE FUNCTION platform_organization_domain_aliases(p_id UUID) RETURNS TEXT[]
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off
AS $$ SELECT coalesce(array_agg(slug ORDER BY retired_at, slug), '{}') FROM organization_domains
      WHERE org_id = p_id AND retired_at IS NOT NULL $$;
REVOKE ALL ON FUNCTION platform_organization_domain_aliases(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_organization_domain_aliases(UUID) TO console_rt;

CREATE OR REPLACE FUNCTION platform_sign_in_options(p_identifier TEXT)
RETURNS TABLE (user_id UUID, credential_ids TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_login  TEXT := split_part(p_identifier, '@', 1);
    v_domain TEXT := split_part(p_identifier, '@', 2);
    v_org    UUID;
    v_user   UUID;
    v_ids    TEXT[];
BEGIN
    -- Only the slug is a domain until domain verification ships (#33). A
    -- SUSPENDED or ARCHIVED tenant answers like an unknown one (synthetic); the
    -- platform tier's own row is ARCHIVED by design (0036) and stays usable.
    -- Session issue refuses an inactive tenant again after proof (tenant_inactive).
    SELECT s.org_id, s.user_id INTO v_org, v_user
      FROM organization_domains d
      JOIN organizations o ON o.id = d.org_id
      JOIN user_sign_in_ids s ON s.org_id = o.id AND s.login = v_login
      JOIN users u ON u.id = s.user_id AND u.org_id = s.org_id
     WHERE d.slug = v_domain AND u.is_active
       AND (d.retired_at IS NULL OR d.alias_until > now())
       AND (o.status = 'ACTIVE' OR o.id = '00000000-0000-0000-0000-00000000face'::uuid)
       AND (s.retired_at IS NULL OR s.alias_until > now());
    SELECT coalesce(array_agg(c.credential_id ORDER BY c.created_at, c.id), '{}')
      INTO v_ids
      FROM auth_webauthn_credentials c
     WHERE c.org_id = v_org AND c.user_id = v_user;
    IF cardinality(v_ids) = 0 THEN
        v_user := NULL;
        SELECT ARRAY[rtrim(translate(encode(hmac(convert_to(p_identifier, 'UTF8'), p.pepper, 'sha256'),
                                            'base64'), '+/', '-_'), '=')]
          INTO v_ids
          FROM auth_security.sign_in_pepper p;
    END IF;
    RETURN QUERY SELECT v_user, v_ids;
END $$;
REVOKE ALL ON FUNCTION platform_sign_in_options(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_sign_in_options(TEXT) TO console_rt;


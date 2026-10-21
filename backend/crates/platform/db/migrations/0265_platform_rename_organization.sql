-- MR-21 (decisions #21 req. 1): a tenant's name and slug can be changed.
--
-- `organizations` is SELECT-only for `console_rt` (0031), so the platform tier
-- writes it through SECURITY DEFINER functions (0036 pattern). This one changes
-- the name and/or the slug of one tenant; NULL keeps the value. The platform
-- sentinel org (`...00face`, slug `platform`) is never renamed (NULL = not
-- found). The table's own CHECK (slug shape, non-empty name) and UNIQUE (slug)
-- stay the guard; the caller maps 23505 / 23514 to `slug_taken` / `slug_invalid`.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION platform_rename_organization(p_id UUID, p_slug TEXT, p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_id = '00000000-0000-0000-0000-00000000face'::uuid THEN
        RETURN NULL;
    END IF;
    SET LOCAL row_security = off;
    UPDATE organizations
    SET slug = COALESCE(p_slug, slug),
        name = COALESCE(p_name, name),
        updated_at = now()
    WHERE id = p_id
    RETURNING id INTO v_id;
    SET LOCAL row_security = on;
    RETURN v_id;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;
REVOKE ALL ON FUNCTION platform_rename_organization(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_rename_organization(UUID, TEXT, TEXT) TO console_rt;

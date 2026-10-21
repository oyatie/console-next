-- Operator-initiated platform bootstrap for an EMPTY database.
--
-- WHY: migrations 0021/0036 used to INSERT the platform sentinel organization and the
-- `Cold Start Admin` account. The squashed `schema at 0225` baseline carries schema only,
-- so a fresh install has neither, `seed_cold_start_credential` finds no admin, and no one
-- can ever sign in. This migration inserts NOTHING. It adds a definer function that the
-- application calls at boot ONLY when an operator configured `CONSOLE_COLDSTART_OTP`, so
-- the platform root exists exactly when someone deliberately bootstraps it.
--
-- Idempotent: returns the existing admin when present. The runtime role (console_rt) is
-- NOBYPASSRLS and has no INSERT on `organizations`, hence SECURITY DEFINER owned by the
-- migration applier (the table owner), matching platform_create_organization (0036).
CREATE FUNCTION public.platform_ensure_cold_start_admin() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    platform_id CONSTANT UUID := '00000000-0000-0000-0000-00000000face';
    admin_id UUID;
BEGIN
    SET LOCAL row_security = off;

    SELECT id INTO admin_id
    FROM users
    WHERE display_name = 'Cold Start Admin'
      AND roles @> ARRAY['SUPER_ADMIN']::TEXT[]
    ORDER BY id
    LIMIT 1;

    IF admin_id IS NULL THEN
        -- Matches 0036: the sentinel is ARCHIVED so it can never be mistaken for a tenant.
        INSERT INTO organizations (id, slug, name, status)
        VALUES (platform_id, 'platform', 'Platform (vendor tier)', 'ARCHIVED')
        ON CONFLICT (id) DO NOTHING;

        PERFORM set_config('app.current_org', platform_id::text, true);
        INSERT INTO users (display_name, roles, is_active, org_id)
        VALUES ('Cold Start Admin', ARRAY['SUPER_ADMIN']::TEXT[], true, platform_id)
        RETURNING id INTO admin_id;
    END IF;

    SET LOCAL row_security = on;
    RETURN admin_id;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_ensure_cold_start_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_ensure_cold_start_admin() TO console_rt;

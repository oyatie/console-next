-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- The API role has forced tenant RLS. Expose only the deployment-wide boot verdict.
CREATE FUNCTION public.has_dev_auth_personas() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT EXISTS (SELECT FROM public.users WHERE phone LIKE 'dev-auth:%') $$;
REVOKE ALL ON FUNCTION public.has_dev_auth_personas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_dev_auth_personas() TO console_rt;

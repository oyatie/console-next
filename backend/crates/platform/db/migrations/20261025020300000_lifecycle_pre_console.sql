-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Setup starts operations at now(); every consumer uses the same local boundary.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION lifecycle_go_live_on(p_org UUID,p_employee UUID,p_on DATE,p_workplace UUID)
RETURNS DATE LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT p.go_live_at FROM tenant_phase p WHERE p.org_id=p_org),now())
   AT TIME ZONE lifecycle_time_zone(p_org,p_employee,p_on,p_workplace))::date
$$;
REVOKE ALL ON FUNCTION lifecycle_go_live_on(UUID,UUID,DATE,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_go_live_on(UUID,UUID,DATE,UUID) TO console_rt;
COMMENT ON FUNCTION lifecycle_go_live_on(UUID,UUID,DATE,UUID) IS
 'Local go-live day, provisionally today in setup; only deadlines strictly before it are pre-console.';

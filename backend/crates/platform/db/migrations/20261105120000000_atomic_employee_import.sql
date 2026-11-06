-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Restrict new capability objects while preserving the existing leave API.
-- contract-of: 20261023061209000
-- A runtime transaction can spend, but cannot mint or read, an import capability.
SET LOCAL lock_timeout = '2s';
CREATE TABLE import_apply_capabilities (
 token UUID PRIMARY KEY, org_id UUID NOT NULL, run_id UUID NOT NULL, actor_id UUID NOT NULL,
 UNIQUE(org_id,run_id), FOREIGN KEY(run_id,org_id) REFERENCES data_import_runs(id,org_id) ON DELETE CASCADE
);
COMMENT ON COLUMN import_apply_capabilities.token IS 'pd:none — one-use command capability';
COMMENT ON COLUMN import_apply_capabilities.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN import_apply_capabilities.run_id IS 'pd:none — approved import run';
COMMENT ON COLUMN import_apply_capabilities.actor_id IS 'pd:personal — admitted actor';
ALTER TABLE import_apply_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_apply_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_apply_capabilities
 USING(org_id=NULLIF(current_setting('app.current_org',true),'')::UUID)
 WITH CHECK(org_id=NULLIF(current_setting('app.current_org',true),'')::UUID);
REVOKE ALL ON import_apply_capabilities FROM PUBLIC,console_rt,console_leave_cmd;
GRANT SELECT,INSERT,UPDATE,DELETE ON import_apply_capabilities TO console_leave_definer;
GRANT USAGE ON SCHEMA import_api TO console_leave_cmd;
CREATE FUNCTION import_api.employee_import_capability(p_org UUID,p_run UUID,p_actor UUID)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 INSERT INTO public.import_apply_capabilities AS c(token,org_id,run_id,actor_id)
 SELECT gen_random_uuid(),r.org_id,r.id,p_actor FROM public.data_import_runs r
 WHERE r.org_id=p_org AND r.id=p_run AND r.status='DRY_RUN'
   AND r.apply_job->>'requested_by'=p_actor::TEXT
 ON CONFLICT(org_id,run_id) DO UPDATE SET token = EXCLUDED.token,
 actor_id = EXCLUDED.actor_id
 RETURNING c.token
$$;
ALTER FUNCTION import_api.employee_import_capability(UUID,UUID,UUID) OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION import_api.employee_import_capability(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_api.employee_import_capability(UUID,UUID,UUID) TO console_leave_cmd;
CREATE FUNCTION import_api.apply_employee_import_batch(
 p_org UUID,p_run UUID,p_source TEXT,p_rows JSONB,p_actor UUID,p_audit JSONB,p_trace TEXT,p_span TEXT,p_capability UUID
) RETURNS TABLE(report JSONB,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 DELETE FROM public.import_apply_capabilities c
 WHERE c.token=p_capability AND c.org_id=p_org AND c.run_id=p_run AND c.actor_id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'import_apply.capability_required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM leave_api.apply_employee_import_batch(p_org,p_run,p_source,p_rows,p_actor,p_audit,p_trace,p_span);
END $$;
ALTER FUNCTION import_api.apply_employee_import_batch(UUID,UUID,TEXT,JSONB,UUID,JSONB,TEXT,TEXT,UUID) OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION import_api.apply_employee_import_batch(UUID,UUID,TEXT,JSONB,UUID,JSONB,TEXT,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_api.apply_employee_import_batch(UUID,UUID,TEXT,JSONB,UUID,JSONB,TEXT,TEXT,UUID) TO console_rt;

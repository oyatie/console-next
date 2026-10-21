-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: provenance and guarded employee import reversal.
SET LOCAL lock_timeout = '2s';
ALTER TABLE data_import_runs
  ADD COLUMN rollback_ledger_complete BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN data_import_runs.rollback_ledger_complete IS 'pd:none — every settle side write has explicit run provenance';
ALTER TABLE data_import_runs DROP CONSTRAINT data_import_runs_rollback_request_pair;
ALTER TABLE data_import_runs ADD CONSTRAINT data_import_runs_rollback_request_pair CHECK (
  (rollback_requested_by IS NULL) = (rollback_requested_at IS NULL)
  AND (status <> 'ROLLED_BACK' OR rollback_reason_code IS NOT NULL));
CREATE TABLE import_run_effects (
  org_id UUID NOT NULL REFERENCES organizations(id),
  run_id UUID NOT NULL,
  employee_id UUID NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('profile_created','rrn_recorded','placed','employment_opened','onboard_scheduled','setup_leave','register_fact','ledger','head_settled')),
  target_id UUID NOT NULL,
  target_digest TEXT NULL CHECK (target_digest IS NULL OR target_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,run_id,employee_id,effect,target_id),
  FOREIGN KEY (run_id,org_id) REFERENCES data_import_runs(id,org_id),
  FOREIGN KEY (employee_id,org_id) REFERENCES employees(id,org_id)
);
COMMENT ON TABLE import_run_effects IS 'Append-only provenance, written beside the side effect';
COMMENT ON COLUMN import_run_effects.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN import_run_effects.run_id IS 'pd:none — source run';
COMMENT ON COLUMN import_run_effects.employee_id IS 'pd:personal — affected employee id';
COMMENT ON COLUMN import_run_effects.effect IS 'pd:none — side-write kind; head_settled captures the final version boundary';
COMMENT ON COLUMN import_run_effects.target_id IS 'pd:personal — exact created record id';
COMMENT ON COLUMN import_run_effects.target_digest IS 'pd:personal — derived digest of a created record, to refuse overwriting later edits';
COMMENT ON COLUMN import_run_effects.created_at IS 'pd:none — database write instant';
ALTER TABLE import_run_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_run_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_run_effects
 USING (org_id=NULLIF(current_setting('app.current_org',true),'')::UUID)
 WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::UUID);
GRANT SELECT,INSERT ON import_run_effects TO console_rt;
GRANT SELECT ON import_run_effects TO console_leave_definer;
CREATE FUNCTION import_run_effects_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'import_run_effects.append_only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER import_run_effects_immutable BEFORE UPDATE OR DELETE ON import_run_effects
 FOR EACH ROW EXECUTE FUNCTION import_run_effects_immutable();
DROP INDEX employee_corrections_import_once_idx;
CREATE UNIQUE INDEX employee_corrections_import_once_idx
 ON employee_corrections(org_id,import_run_id,employee_id,field,reason_code)
 WHERE import_run_id IS NOT NULL;
ALTER TABLE change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (
 'PROFILE_CORRECTION','IDENTITY_REVIEW','ACCESS_REQUEST','SCOPE_ACTION','OTHER',
 'ACCESS_EXPLANATION','POLICY_QUESTION','EMPLOYEE_VOID','IMPORT_ROLLBACK'));
ALTER TABLE change_requests DROP CONSTRAINT change_requests_subject_type_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_subject_type_check CHECK
 (subject_type IN ('EMPLOYEE','USER_ACCOUNT','BRANCH','ORGANIZATION','DATA_IMPORT_RUN'));
CREATE UNIQUE INDEX change_requests_import_rollback_open_idx
 ON change_requests(org_id,subject_id) WHERE kind='IMPORT_ROLLBACK' AND status='OPEN';
INSERT INTO realtime_topic_map(target_type,action,resource_type,carries_id) VALUES
 ('data_import_run','data_import.rollback_request','import_run',true),
 ('data_import_run','data_import.rollback','import_run',true);
CREATE OR REPLACE FUNCTION leave_api.employee_import_run_writer_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.entity_type IS DISTINCT FROM OLD.entity_type THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'data_import_run.entity_type_immutable';
    END IF;
    IF current_user <> 'console_leave_definer' THEN
        IF TG_OP = 'INSERT' AND NEW.entity_type = 'employee_hr' AND (
            NEW.status IN ('APPLIED','ROLLED_BACK')
            OR NEW.apply_summary IS DISTINCT FROM '{}'::JSONB
            OR NEW.applied_by IS NOT NULL
            OR NEW.applied_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'employee_import_run.command_required';
        ELSIF TG_OP = 'UPDATE'
           AND (OLD.entity_type = 'employee_hr' OR NEW.entity_type = 'employee_hr')
           AND (
                ((OLD.status = 'APPLIED' OR NEW.status = 'APPLIED')
                    AND NEW.status IS DISTINCT FROM OLD.status)
                OR NEW.apply_summary IS DISTINCT FROM OLD.apply_summary
                OR NEW.applied_by IS DISTINCT FROM OLD.applied_by
                OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
           ) THEN
            IF current_user <> 'console_rt'
               OR OLD.entity_type <> 'employee_hr'
               OR NEW.entity_type <> 'employee_hr'
               OR OLD.status <> 'DRY_RUN'
               OR NEW.status <> 'APPLIED'
               OR NEW.applied_by IS NULL
               OR NEW.applied_at IS NULL
               OR (pg_catalog.to_jsonb(NEW) - ARRAY[
                    'status','apply_summary','applied_by','applied_at','updated_at'
                  ]::TEXT[]) IS DISTINCT FROM
                  (pg_catalog.to_jsonb(OLD) - ARRAY[
                    'status','apply_summary','applied_by','applied_at','updated_at'
                  ]::TEXT[]) THEN
                RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'employee_import_run.command_required';
            END IF;
        END IF;
    END IF;
    IF current_user <> 'console_leave_definer' AND TG_OP = 'UPDATE'
       AND NEW.entity_type = 'employee_hr' AND (
         NEW.rolled_back_by IS DISTINCT FROM OLD.rolled_back_by OR
         NEW.rolled_back_at IS DISTINCT FROM OLD.rolled_back_at OR
         NEW.rollback_requested_by IS DISTINCT FROM OLD.rollback_requested_by OR
         NEW.rollback_requested_at IS DISTINCT FROM OLD.rollback_requested_at OR
         NEW.rollback_reason_code IS DISTINCT FROM OLD.rollback_reason_code OR
         NEW.rollback_note IS DISTINCT FROM OLD.rollback_note) THEN
      RAISE EXCEPTION 'employee_import_run.command_required' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION leave_api.employee_import_run_writer_guard() OWNER TO console_leave_definer;

GRANT SELECT ON change_requests TO console_leave_definer;
GRANT UPDATE (status,rolled_back_by,rolled_back_at,rollback_reason_code,rollback_note,rollback_requested_by,rollback_requested_at)
 ON data_import_runs TO console_leave_definer;
CREATE FUNCTION leave_api.mark_employee_import_rolled_back(
 p_org UUID,p_run UUID,p_actor UUID,p_requested_by UUID,p_reason TEXT,p_note TEXT,
 p_audit UUID,p_trace TEXT,p_span TEXT
) RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE v_at TIMESTAMPTZ;
BEGIN
 PERFORM leave_api.assert_context(p_org,p_actor,p_trace,p_span);

 IF p_requested_by=p_actor THEN
   RAISE EXCEPTION 'authz_sod_requester' USING ERRCODE='42501';
 END IF;
 IF p_requested_by IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM public.change_requests WHERE org_id=p_org AND subject_id=p_run
    AND kind='IMPORT_ROLLBACK' AND status='OPEN' AND requested_by=p_requested_by
 ) THEN RAISE EXCEPTION 'import_rollback_request_required' USING ERRCODE='42501'; END IF;
 UPDATE public.data_import_runs SET status='ROLLED_BACK',rolled_back_by=p_actor,
  rolled_back_at=clock_timestamp(),rollback_reason_code=p_reason,rollback_note=p_note,
  rollback_requested_by=p_requested_by,
  rollback_requested_at=CASE WHEN p_requested_by IS NULL THEN NULL ELSE
    (SELECT created_at FROM public.change_requests WHERE org_id=p_org AND subject_id=p_run
      AND kind='IMPORT_ROLLBACK' AND status='OPEN') END
 WHERE org_id=p_org AND id=p_run AND entity_type='employee_hr' AND status='APPLIED'
 RETURNING rolled_back_at INTO v_at;
 IF v_at IS NULL THEN RAISE EXCEPTION 'import_run_not_applied' USING ERRCODE='23514'; END IF;
 RETURN v_at;
END $$;
ALTER FUNCTION leave_api.mark_employee_import_rolled_back(UUID,UUID,UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT) OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION leave_api.mark_employee_import_rolled_back(UUID,UUID,UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leave_api.mark_employee_import_rolled_back(UUID,UUID,UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT) TO console_rt;
CREATE FUNCTION leave_api.employee_import_rollback_audit_required() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF NEW.status='ROLLED_BACK' AND OLD.status='APPLIED' THEN
   PERFORM pg_catalog.set_config('app.current_org',NEW.org_id::TEXT,true);
   IF (SELECT count(*) FROM public.audit_events a WHERE a.org_id=NEW.org_id
       AND a.action='data_import.rollback' AND a.target_type='data_import_run'
       AND a.target_id=NEW.id::TEXT AND a.actor=NEW.rolled_back_by
       AND a.xmin=pg_catalog.pg_current_xact_id()::xid) <> 1 THEN
     RAISE EXCEPTION 'employee_import_run.current_transaction_audit_required' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION leave_api.employee_import_rollback_audit_required() OWNER TO console_leave_definer;
CREATE CONSTRAINT TRIGGER employee_import_rollback_audit_required AFTER UPDATE ON data_import_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION leave_api.employee_import_rollback_audit_required();
-- Deletions are limited to the exact records this run created; history is untouched.
GRANT SELECT,DELETE ON employee_employment_profiles,employee_register_facts,employee_rrn TO console_leave_definer;
CREATE FUNCTION leave_api.remove_employee_import_effects(p_org UUID,p_run UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org',true),'')::UUID
 OR NOT EXISTS (SELECT 1 FROM public.data_import_runs WHERE org_id=p_org AND id=p_run
    AND entity_type='employee_hr' AND status='ROLLED_BACK' AND rollback_ledger_complete
    AND xmin=pg_catalog.pg_current_xact_id()::xid) THEN
   RAISE EXCEPTION 'import_run_not_applied' USING ERRCODE='42501';
 END IF;
 DELETE FROM public.employee_employment_profiles p USING public.import_run_effects f
 WHERE f.org_id=p_org AND f.run_id=p_run AND f.effect='profile_created'
   AND p.org_id=f.org_id AND p.employee_id=f.target_id;
 DELETE FROM public.employee_register_facts p USING public.import_run_effects f
 WHERE f.org_id=p_org AND f.run_id=p_run AND f.effect='register_fact'
   AND p.org_id=f.org_id AND p.employee_id=f.target_id;
 DELETE FROM public.employee_rrn p USING public.import_run_effects f
 WHERE f.org_id=p_org AND f.run_id=p_run AND f.effect='rrn_recorded'
   AND p.org_id=f.org_id AND p.employee_id=f.target_id AND p.import_run_id=p_run;
END $$;
ALTER FUNCTION leave_api.remove_employee_import_effects(UUID,UUID) OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION leave_api.remove_employee_import_effects(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leave_api.remove_employee_import_effects(UUID,UUID) TO console_rt;

DROP FUNCTION setting_definition(TEXT);
-- BEGIN GENERATED by console-settings-domain tests/sql_definitions.rs
CREATE FUNCTION setting_definition(
    p_key TEXT,
    OUT kind TEXT,
    OUT min_value BIGINT,
    OUT max_value BIGINT,
    OUT default_ordinal BIGINT,
    OUT looser_when TEXT,
    OUT governance TEXT,
    OUT codes TEXT[]
)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT d.kind, d.min_value, d.max_value, d.default_ordinal, d.looser_when, d.governance, d.codes
    FROM (VALUES
        ('approval.overdue.escalate_after_business_days', 'int', 1::BIGINT, NULL::BIGINT, 2::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.delegation.max_days', 'int', 1::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.returned.reminder_days', 'int', 1::BIGINT, NULL::BIGINT, 3::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.doc_class.registered_branch_change.requires_governing_body_decision', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'fixed', NULL::TEXT[]),
        ('approval.doc_class.registered_manager_appointment.requires_governing_body_decision', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'fixed', NULL::TEXT[]),
        ('corporate.small_company_383_proviso', 'bool', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date.backdate_soft_days', 'int', 3::BIGINT, 14::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date.future_soft_days', 'int', 30::BIGINT, 365::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date_unknown.resolve_days', 'int', 1::BIGINT, 14::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.hq_review.lead_days', 'int', 1::BIGINT, 30::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('exit.hq_review.post_apply_days', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.access.revoke_mode.voluntary', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['ON_CONFIRM', 'END_OF_EXIT_DATE']::TEXT[]),
        ('exit.access.revoke_mode.involuntary', 'code', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', ARRAY['ON_CONFIRM', 'END_OF_EXIT_DATE']::TEXT[]),
        ('exit.access.handover_max_days', 'int', 0::BIGINT, 30::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.access.self_service_days', 'int', 30::BIGINT, 1095::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.settlement.wage_deviation_pct', 'int', 0::BIGINT, 10::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('lifecycle.backdate_soft_floor_days', 'int', 0::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exceptions.approval_ttl_days', 'int', 1::BIGINT, 30::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('withholding.filing_cadence', 'code', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'neutral', 'tenant', ARRAY['MONTHLY', 'SEMIANNUAL']::TEXT[]),
        ('period_lock.unlock_max_days', 'int', 1::BIGINT, 14::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('auth.idle_timeout_minutes', 'int', 5::BIGINT, 60::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('authz.sole_holder.mode', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['refuse', 'step_up_notice_review']::TEXT[]),
        ('authz.elevated_grant.sole_admin_delay', 'int', 24::BIGINT, 168::BIGINT, 24::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.second_person.min_grant_age', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.second_person.response_due', 'int', 1::BIGINT, 120::BIGINT, 48::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('security_contact.reverify_interval', 'int', 1::BIGINT, 12::BIGINT, 12::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('review.sole_holder_exception.due', 'int', 1::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('audit.permission_change.retention', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('audit.access_log.retention', 'int', 2::BIGINT, NULL::BIGINT, 2::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.cooling_period', 'int', 3::BIGINT, NULL::BIGINT, 7::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.retrieval_window', 'int', 30::BIGINT, NULL::BIGINT, 60::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.destroy_after_due', 'int', 0::BIGINT, 5::BIGINT, 5::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('offboarding.archive_service.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('backup.archive_tail', 'int', NULL::BIGINT, NULL::BIGINT, 35::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('privacy.exit_processing_overdue_after', 'int', 1::BIGINT, 180::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('retention.labor.employee_register', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.employment_contract', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.wage_ledger', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.wage_basis', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.hire_exit', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.promotion_pay_change', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.leave', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.written_agreements', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.minor_proof', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.tax.books_evidence', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.nhis.employer_docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.nps.member_notice_proof', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.equality.docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.equality.grievance', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.severance.interim_proof', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.safety.docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.recruiting.docs', 'int', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.cross_entity_grant.basis_required', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.entity_registration_document', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('hr.record.education.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.qualification.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.military.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.training.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.language.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.award.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.discipline.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.family.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.disability.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.veteran.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('people.void_window', 'int', 1::BIGINT, 30::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('people.void_pii_retention', 'int', 0::BIGINT, 30::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.policy.org_structure', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.people_correction', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.identity_merge', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.registration_void', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.exit', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.import_rollback', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('import.upload.max_mib', 'int', 1::BIGINT, 64::BIGINT, 16::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_entries', 'int', 16::BIGINT, 10000::BIGINT, 1000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_expanded_mib', 'int', 1::BIGINT, 1024::BIGINT, 128::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_ratio', 'int', 10::BIGINT, 1000::BIGINT, 200::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.sheet.max_grid_cells', 'int', 1000::BIGINT, 50000000::BIGINT, 5000000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.workbook.max_cells', 'int', 1000::BIGINT, 10000000::BIGINT, 2000000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.employee_number.unnumbered', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['queue', 'assign_by_rule']::TEXT[]),
        ('import.staged_identity.ttl_days', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('import.rollback.window_days', 'int', 1::BIGINT, 30::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('import.apply.max_rows', 'int', 100::BIGINT, 3000::BIGINT, 2000::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('db.pool.api_connections', 'int', 2::BIGINT, 48::BIGINT, 16::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.worker_connections', 'int', 2::BIGINT, 32::BIGINT, 6::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.acquire_timeout_ms', 'int', 100::BIGINT, 10000::BIGINT, 1000::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.peak_api_processes', 'int', 1::BIGINT, 8::BIGINT, 2::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.peak_worker_processes', 'int', 1::BIGINT, 8::BIGINT, 2::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.reserved_connections', 'int', 0::BIGINT, 32::BIGINT, 8::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('attendance.excess.notice_minutes', 'int', 0::BIGINT, 30::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('attendance.entry.long_span_confirm_minutes', 'int', 1::BIGINT, 1440::BIGINT, 960::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('attendance.late.grace_minutes', 'int', 0::BIGINT, 60::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

DROP FUNCTION system_reason_codes();
-- BEGIN GENERATED by console-settings-domain code_lists/tests.rs
CREATE FUNCTION system_reason_codes()
RETURNS TABLE (domain TEXT, code TEXT, requires_note BOOLEAN, sort INT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    VALUES
        ('org_change_reason', 'NEW_BUSINESS_SITE', false, 1),
        ('org_change_reason', 'CONSOLIDATION', false, 2),
        ('org_change_reason', 'WORK_REALLOCATION', false, 3),
        ('org_change_reason', 'RENAMING', false, 4),
        ('org_change_reason', 'COMPLIANCE_FINDING', false, 5),
        ('org_change_reason', 'OTHER', true, 6),
        ('org_change_reject', 'EFFECTIVE_DATE_REVIEW', false, 1),
        ('org_change_reject', 'INSUFFICIENT_BASIS', false, 2),
        ('org_change_reject', 'WRONG_TARGET', false, 3),
        ('org_change_reject', 'POLICY_VIOLATION', false, 4),
        ('org_change_reject', 'OTHER', true, 5),
        ('approval_return', 'NEEDS_SUPPLEMENT', false, 1),
        ('approval_return', 'ADD_EVIDENCE', false, 2),
        ('approval_return', 'ADJUST_EFFECTIVE_DATE', false, 3),
        ('approval_return', 'CORRECT_TARGET', false, 4),
        ('approval_return', 'OTHER', true, 5),
        ('org_change_cancel', 'DUPLICATE_DRAFT', false, 1),
        ('org_change_cancel', 'PLAN_CHANGED', false, 2),
        ('org_change_cancel', 'DRAFTING_ERROR', false, 3),
        ('org_change_cancel', 'OTHER', true, 4),
        ('org_change_withdraw', 'DUPLICATE_DRAFT', false, 1),
        ('org_change_withdraw', 'PLAN_CHANGED', false, 2),
        ('org_change_withdraw', 'DRAFTING_ERROR', false, 3),
        ('org_change_withdraw', 'OTHER', true, 4),
        ('lifecycle_transfer', 'REGULAR_RESHUFFLE', false, 1),
        ('lifecycle_transfer', 'REORGANIZATION', false, 2),
        ('lifecycle_transfer', 'EMPLOYEE_REQUEST', false, 3),
        ('lifecycle_transfer', 'BUSINESS_NEED', false, 4),
        ('lifecycle_transfer', 'OTHER', true, 5),
        ('lifecycle_promote', 'REGULAR_PROMOTION', false, 1),
        ('lifecycle_promote', 'SPECIAL_PROMOTION', false, 2),
        ('lifecycle_promote', 'DISCIPLINARY_DEMOTION', false, 3),
        ('lifecycle_promote', 'OTHER', true, 4),
        ('lifecycle_cancel', 'INPUT_ERROR', false, 1),
        ('lifecycle_cancel', 'SCHEDULE_CHANGED', false, 2),
        ('lifecycle_cancel', 'PLAN_WITHDRAWN', false, 3),
        ('lifecycle_cancel', 'OTHER', true, 4),
        ('exit_reason', 'PERSONAL', false, 1),
        ('exit_reason', 'FAMILY', false, 2),
        ('exit_reason', 'ILLNESS', false, 3),
        ('exit_reason', 'STUDY', false, 4),
        ('exit_reason', 'WORKING_CONDITIONS', false, 5),
        ('exit_reason', 'WAGE_ARREARS', false, 6),
        ('exit_reason', 'RELOCATION', false, 7),
        ('exit_reason', 'CLOSURE', false, 8),
        ('exit_reason', 'INSOLVENCY', false, 9),
        ('exit_reason', 'ADVISED_RESIGNATION_BUSINESS', false, 10),
        ('exit_reason', 'REDUNDANCY_DISMISSAL', false, 11),
        ('exit_reason', 'DISCIPLINARY_DISMISSAL', false, 12),
        ('exit_reason', 'ADVISED_RESIGNATION_FAULT', false, 13),
        ('exit_reason', 'RETIREMENT_AGE', false, 14),
        ('exit_reason', 'CONTRACT_END', false, 15),
        ('exit_reason', 'PROJECT_END', false, 16),
        ('exit_reason', 'COVERAGE_EXCLUDED', false, 17),
        ('exit_reason', 'DUAL_EMPLOYMENT', false, 18),
        ('exit_reason', 'DEATH', false, 19),
        ('exit_reason', 'OTHER', true, 20),
        ('exit_reject', 'EMPLOYEE_WITHDREW', false, 1),
        ('exit_reject', 'NOT_FACTUAL', false, 2),
        ('exit_reject', 'OTHER', true, 3),
        ('exit_cancel', 'EMPLOYEE_WITHDREW', false, 1),
        ('exit_cancel', 'REPORT_ERROR', false, 2),
        ('exit_cancel', 'OTHER', true, 3),
        ('period_lock', 'MONTHLY_PAYROLL_CLOSE', false, 1),
        ('period_lock', 'BOOKS_CLOSE', false, 2),
        ('period_lock', 'TAX_FILING', false, 3),
        ('period_lock', 'AUDIT_RESPONSE', false, 4),
        ('period_lock', 'OTHER', true, 5),
        ('period_unlock', 'RETRO_CORRECTION', false, 1),
        ('period_unlock', 'PAYROLL_ERROR', false, 2),
        ('period_unlock', 'AUDIT_FINDING', false, 3),
        ('period_unlock', 'OTHER', true, 4),
        ('role_change', 'PROMOTION_OR_REASSIGNMENT', false, 1),
        ('role_change', 'EXIT_OR_LEAVE', false, 2),
        ('role_change', 'ACCESS_CLEANUP', false, 3),
        ('role_change', 'ERROR_CORRECTION', false, 4),
        ('role_change', 'OTHER', true, 5),
        ('deactivate', 'EXIT', false, 1),
        ('deactivate', 'LEAVE', false, 2),
        ('deactivate', 'SECURITY_INCIDENT', false, 3),
        ('deactivate', 'DUPLICATE_ACCOUNT', false, 4),
        ('deactivate', 'OTHER', true, 5),
        ('credential_reset', 'DEVICE_LOST', false, 1),
        ('credential_reset', 'DEVICE_REPLACED', false, 2),
        ('credential_reset', 'COMPROMISE_SUSPECTED', false, 3),
        ('credential_reset', 'OTHER', true, 4),
        ('import_rollback', 'WRONG_FILE', false, 1),
        ('import_rollback', 'WRONG_MAPPING', false, 2),
        ('import_rollback', 'DUPLICATE_RUN', false, 3),
        ('import_rollback', 'OTHER', true, 4),
        ('import_exclude', 'DUPLICATE', false, 1),
        ('import_exclude', 'FORMAT_ERROR', false, 2),
        ('import_exclude', 'OUT_OF_SCOPE', false, 3),
        ('import_exclude', 'OTHER', true, 4),
        ('exception', 'OTHER', true, 1),
        ('retained_record_purpose', 'EMPLOYMENT_CERTIFICATE', false, 1),
        ('retained_record_purpose', 'SEPARATION_CONFIRMATION', false, 2),
        ('retained_record_purpose', 'PAYMENT_STATEMENT_FILING', false, 3),
        ('retained_record_purpose', 'WITHHOLDING_CORRECTION', false, 4),
        ('retained_record_purpose', 'EXIT_PROCESSING_COMPLETION', false, 5),
        ('retained_record_purpose', 'DISPUTE_OR_INSPECTION', false, 6),
        ('retained_record_purpose', 'DATA_SUBJECT_ACCESS', false, 7),
        ('retained_record_purpose', 'OTHER', true, 8),
        ('restricted_record_purpose', 'STATUTORY_REPORTING', false, 1),
        ('restricted_record_purpose', 'WORK_ACCOMMODATION', false, 2),
        ('restricted_record_purpose', 'DISCIPLINARY_PROCEDURE', false, 3),
        ('restricted_record_purpose', 'RECORD_CORRECTION', false, 4),
        ('restricted_record_purpose', 'DISPUTE_OR_INSPECTION', false, 5),
        ('restricted_record_purpose', 'DATA_SUBJECT_ACCESS', false, 6),
        ('restricted_record_purpose', 'OTHER', true, 7),
        ('rrn_reveal', 'PAYROLL_WITHHOLDING', false, 1),
        ('rrn_reveal', 'SOCIAL_INSURANCE_FILING', false, 2),
        ('rrn_reveal', 'IDENTITY_VERIFICATION', false, 3),
        ('rrn_reveal', 'DATA_SUBJECT_ACCESS', false, 4),
        ('rrn_reveal', 'OTHER', true, 5),
        ('employee_number_change', 'NUMBERING_SCHEME_CHANGE', false, 1),
        ('employee_number_change', 'ENTITY_TRANSFER', false, 2),
        ('employee_number_change', 'INPUT_ERROR', false, 3),
        ('employee_number_change', 'LEGACY_MIGRATION', false, 4),
        ('employee_number_change', 'OTHER', true, 5),
        ('sign_in_id_change', 'NAME_CHANGE', false, 1),
        ('sign_in_id_change', 'INPUT_ERROR', false, 2),
        ('sign_in_id_change', 'HOLDER_REQUEST', false, 3),
        ('sign_in_id_change', 'SECURITY_INCIDENT', false, 4),
        ('sign_in_id_change', 'OTHER', true, 5)
$$;
-- END GENERATED

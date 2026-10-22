-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; released migrations are immutable. Stamped by tools/lanes/new-migration.py.
SET LOCAL lock_timeout = '2s';
-- console-gate: audited-table ops_recovery_requests
CREATE TABLE ops_recovery_requests (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    target_user_id UUID NOT NULL,
    requested_by UUID NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    authoriser_role TEXT NOT NULL CHECK (authoriser_role IN ('REPRESENTATIVE','SECURITY_CONTACT')),
    authoriser_name TEXT NOT NULL CHECK (length(trim(authoriser_name)) BETWEEN 1 AND 100),
    proofing_method TEXT NOT NULL CHECK (length(trim(proofing_method)) BETWEEN 1 AND 100),
    evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 200),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    hold_until TIMESTAMPTZ,
    cancelled_by UUID,
    cancelled_at TIMESTAMPTZ,
    cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(trim(cancel_reason)) BETWEEN 1 AND 200),
    issued_by UUID,
    issued_at TIMESTAMPTZ,
    open_assertion UUID NOT NULL UNIQUE,
    approve_assertion UUID UNIQUE,
    code_credential_id UUID UNIQUE,
    code_redeemed_at TIMESTAMPTZ,
    PRIMARY KEY (org_id,id),
    FOREIGN KEY (target_user_id,org_id) REFERENCES users(id,org_id) ON DELETE CASCADE,
    CONSTRAINT ops_recovery_evidence_identifier CHECK (regexp_replace(normalize(evidence_ref,NFKC),'[[:space:]]','','g') !~ '[0-9]{6}-?[1-8][0-9]{6}'),
    CONSTRAINT ops_recovery_name_identifier CHECK (regexp_replace(normalize(authoriser_name,NFKC),'[[:space:]]','','g') !~ '[0-9]{6}-?[1-8][0-9]{6}'),
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
    CHECK ((approved_by IS NULL) = (hold_until IS NULL)),
    CHECK ((approved_by IS NULL) = (approve_assertion IS NULL)),
    CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL)),
    CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
    CHECK ((issued_by IS NULL) = (issued_at IS NULL)),
    CHECK (issued_at IS NULL OR (approved_at IS NOT NULL AND issued_at >= hold_until AND cancelled_at IS NULL))
);
CREATE UNIQUE INDEX ops_recovery_one_open ON ops_recovery_requests(org_id) WHERE cancelled_at IS NULL AND issued_at IS NULL;
ALTER TABLE ops_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_recovery_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ops_recovery_requests
    USING (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid)
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
CREATE TRIGGER ops_recovery_org_immutable BEFORE UPDATE ON ops_recovery_requests FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
REVOKE ALL ON ops_recovery_requests FROM PUBLIC, console_rt;
GRANT SELECT,INSERT ON ops_recovery_requests TO console_rt;
GRANT UPDATE(approved_by,approved_at,hold_until,approve_assertion,cancelled_by,cancelled_at,cancel_reason,issued_by,issued_at,code_credential_id,code_redeemed_at) ON ops_recovery_requests TO console_rt;
COMMENT ON TABLE ops_recovery_requests IS 'Same-holder governed ops recovery; audited under the tenant; no code stored';
COMMENT ON COLUMN ops_recovery_requests.org_id IS 'pd:none — recovery org id';
COMMENT ON COLUMN ops_recovery_requests.id IS 'pd:none — recovery id';
COMMENT ON COLUMN ops_recovery_requests.target_user_id IS 'pd:personal — recovery target user id';
COMMENT ON COLUMN ops_recovery_requests.requested_by IS 'pd:personal — recovery requested by';
COMMENT ON COLUMN ops_recovery_requests.opened_at IS 'pd:none — recovery opened at';
COMMENT ON COLUMN ops_recovery_requests.authoriser_role IS 'pd:none — recovery authoriser role';
COMMENT ON COLUMN ops_recovery_requests.authoriser_name IS 'pd:personal — recovery authoriser name';
COMMENT ON COLUMN ops_recovery_requests.proofing_method IS 'pd:none — recovery proofing method';
COMMENT ON COLUMN ops_recovery_requests.evidence_ref IS 'pd:personal — recovery evidence ref';
COMMENT ON COLUMN ops_recovery_requests.approved_by IS 'pd:personal — recovery approved by';
COMMENT ON COLUMN ops_recovery_requests.approved_at IS 'pd:none — recovery approved at';
COMMENT ON COLUMN ops_recovery_requests.hold_until IS 'pd:none — recovery hold until';
COMMENT ON COLUMN ops_recovery_requests.cancelled_by IS 'pd:personal — recovery cancelled by';
COMMENT ON COLUMN ops_recovery_requests.cancelled_at IS 'pd:none — recovery cancelled at';
COMMENT ON COLUMN ops_recovery_requests.cancel_reason IS 'pd:personal — recovery cancel reason';
COMMENT ON COLUMN ops_recovery_requests.issued_by IS 'pd:personal — recovery issued by';
COMMENT ON COLUMN ops_recovery_requests.issued_at IS 'pd:none — recovery issued at';
COMMENT ON COLUMN ops_recovery_requests.open_assertion IS 'pd:none — recovery open assertion';
COMMENT ON COLUMN ops_recovery_requests.approve_assertion IS 'pd:none — recovery approve assertion';
COMMENT ON COLUMN ops_recovery_requests.code_credential_id IS 'pd:none — recovery code credential id';
COMMENT ON COLUMN ops_recovery_requests.code_redeemed_at IS 'pd:none — recovery code redeemed at';

ALTER TABLE api_idempotency_keys DROP CONSTRAINT api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
        'period_lock.unlock_reject',
        'employee.correction.bulk', 'appointment_notice.issue',
        'tenant.domain.request', 'platform.tenant.rename'
    ,
        'platform.tenant.ops_recovery.open',
        'platform.tenant.ops_recovery.approve',
        'platform.tenant.ops_recovery.issue',
        'platform.tenant.ops_recovery.cancel')) NOT VALID;
ALTER TABLE api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_operation_check;
-- BEGIN GENERATED by console-settings-domain tests/sql_definitions.rs
CREATE OR REPLACE FUNCTION setting_definition(
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
        ('import.upload.max_mib', 'int', 1::BIGINT, 64::BIGINT, 16::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_entries', 'int', 16::BIGINT, 10000::BIGINT, 1000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_expanded_mib', 'int', 1::BIGINT, 1024::BIGINT, 128::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_ratio', 'int', 10::BIGINT, 1000::BIGINT, 200::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.sheet.max_grid_cells', 'int', 1000::BIGINT, 50000000::BIGINT, 5000000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.workbook.max_cells', 'int', 1000::BIGINT, 10000000::BIGINT, 2000000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.employee_number.unnumbered', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['queue', 'assign_by_rule']::TEXT[]),
        ('import.staged_identity.ttl_days', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('import.apply.max_rows', 'int', 100::BIGINT, 3000::BIGINT, 2000::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('db.pool.api_connections', 'int', 2::BIGINT, 48::BIGINT, 16::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.worker_connections', 'int', 2::BIGINT, 32::BIGINT, 6::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.acquire_timeout_ms', 'int', 100::BIGINT, 10000::BIGINT, 1000::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.peak_api_processes', 'int', 1::BIGINT, 8::BIGINT, 2::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.peak_worker_processes', 'int', 1::BIGINT, 8::BIGINT, 2::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('db.pool.reserved_connections', 'int', 0::BIGINT, 32::BIGINT, 8::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('attendance.excess.notice_minutes', 'int', 0::BIGINT, 30::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('attendance.entry.long_span_confirm_minutes', 'int', 1::BIGINT, 1440::BIGINT, 960::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('attendance.late.grace_minutes', 'int', 0::BIGINT, 60::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('ops_recovery.hold_hours', 'int', 24::BIGINT, 168::BIGINT, 72::BIGINT, 'lower', 'platform_only', NULL::TEXT[]),
        ('ops_recovery.code_ttl_minutes', 'int', 5::BIGINT, 10::BIGINT, 10::BIGINT, 'higher', 'platform_only', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

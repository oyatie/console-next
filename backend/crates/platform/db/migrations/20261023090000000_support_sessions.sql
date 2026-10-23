-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand-only support ledger; vendor identities never become tenant accounts.
SET LOCAL lock_timeout = '2s';
ALTER TABLE auth_webauthn_ceremony_bindings DROP CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check;
ALTER TABLE auth_webauthn_ceremony_bindings ADD CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check CHECK (action_kind IN ('APPROVAL_DECISION','POLL_VOTE','EXIT_CONFIRM','EXIT_RESCIND','ELEVATED_GRANT','PERIOD_UNLOCK','IDENTITY_MERGE','EXCEPTION_DECIDE','SETTINGS_CHANGE','CREDENTIAL_RESET','TENANT_OFFBOARD','OPERATOR_RECOVERY','SUPPORT_SESSION')) NOT VALID;
ALTER TABLE auth_webauthn_ceremony_bindings VALIDATE CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check;
ALTER TABLE access_role_lines DROP CONSTRAINT access_role_lines_domain_check;
ALTER TABLE access_role_lines ADD CONSTRAINT access_role_lines_domain_check CHECK (domain IN ('org','hr_basic','appointment','exit','attendance','pay','bank','evaluation','discipline','sensitive','documents','notice','access','audit','settings','exceptions','retention','tenant','support_access')) NOT VALID;
ALTER TABLE access_role_lines VALIDATE CONSTRAINT access_role_lines_domain_check;
-- console-gate: audited-table support_sessions
CREATE TABLE support_sessions (
    org_id UUID NOT NULL REFERENCES organizations(id),
    id UUID NOT NULL,
    operator_ref UUID NOT NULL,
    operator_label TEXT NOT NULL,
    ticket_ref TEXT NOT NULL CHECK (length(trim(ticket_ref)) BETWEEN 1 AND 200),
    reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 1 AND 100),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
    scope TEXT[] NOT NULL CHECK (cardinality(scope)>0),
    mode TEXT NOT NULL DEFAULT 'READ' CHECK (mode='READ'),
    masked BOOLEAN NOT NULL DEFAULT true,
    reveal_classes TEXT[] NOT NULL DEFAULT '{}',
    requested_duration_seconds BIGINT NOT NULL CHECK (requested_duration_seconds>0),
    approved_duration_seconds BIGINT CHECK (approved_duration_seconds>0 AND approved_duration_seconds<=requested_duration_seconds),
    state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','OPERATOR_APPROVED','ACTIVE','ENDED','EXPIRED','DENIED','REVOKED')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_expires_at TIMESTAMPTZ NOT NULL,
    operator_approver_ref UUID,
    operator_approved_at TIMESTAMPTZ,
    tenant_approver_ref UUID,
    tenant_approved_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    request_assertion UUID NOT NULL UNIQUE,
    approval_assertion UUID UNIQUE,
    PRIMARY KEY (org_id,id),
    CHECK (operator_approver_ref IS NULL OR operator_approver_ref<>operator_ref),
    CHECK ((operator_approver_ref IS NULL)=(approval_assertion IS NULL)),
    CHECK ((operator_approver_ref IS NULL)=(operator_approved_at IS NULL)),
    CHECK ((tenant_approver_ref IS NULL)=(tenant_approved_at IS NULL)),
    CHECK (state NOT IN ('OPERATOR_APPROVED','ACTIVE') OR operator_approver_ref IS NOT NULL),
    CHECK (state<>'ACTIVE' OR (tenant_approver_ref IS NOT NULL AND approved_duration_seconds IS NOT NULL AND started_at IS NOT NULL AND expires_at>started_at)),
    CHECK (masked=(cardinality(reveal_classes)=0))
);
-- console-gate: audited-table support_session_decisions
CREATE TABLE support_session_decisions (
    org_id UUID NOT NULL,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    actor_ref UUID NOT NULL,
    actor_label TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('REQUEST','OPERATOR_APPROVE','APPROVE','DENY','START','END','EXPIRE')),
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,id),
    FOREIGN KEY(org_id,session_id) REFERENCES support_sessions(org_id,id)
);
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON support_sessions USING(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid) WITH CHECK(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
ALTER TABLE support_session_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_session_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON support_session_decisions USING(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid) WITH CHECK(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
CREATE TRIGGER support_org_immutable BEFORE UPDATE ON support_sessions FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE INDEX support_sessions_due ON support_sessions(request_expires_at,expires_at) WHERE state IN ('REQUESTED','OPERATOR_APPROVED','ACTIVE');
REVOKE ALL ON support_sessions,support_session_decisions FROM PUBLIC;
GRANT SELECT,INSERT ON support_sessions,support_session_decisions TO console_rt;
GRANT UPDATE(state,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at,approved_duration_seconds,reveal_classes,masked,started_at,expires_at,ended_at) ON support_sessions TO console_rt;

-- Reference data is an explicit allow list. New read surfaces require review of their response classification.
CREATE TABLE support_read_surfaces(path TEXT PRIMARY KEY, domain TEXT NOT NULL, feature TEXT NOT NULL, classification_tables TEXT[] NOT NULL, field_classes JSONB NOT NULL DEFAULT '{}');
INSERT INTO support_read_surfaces VALUES
('/api/v1/org-structure','org','org_change_read',ARRAY['legal_entities','org_units','workplaces','business_registrations'],'{}'),
('/api/v1/org-units','org','org_change_read',ARRAY['org_units'],'{}'),
('/api/v1/legal-entities','org','org_change_read',ARRAY['legal_entities'],'{}'),
('/api/v1/workplaces','org','org_change_read',ARRAY['workplaces'],'{}'),
('/api/v1/employees','hr_basic','employee_directory_read',ARRAY['employees'],'{"display_name":"personal","personal_email":"personal","count":"metadata","total":"metadata"}');
GRANT SELECT ON support_read_surfaces TO console_rt;
COMMENT ON TABLE support_read_surfaces IS 'Reviewed support read surfaces; unknown paths fail closed';
COMMENT ON COLUMN support_read_surfaces.path IS 'pd:none — metadata: API route';
COMMENT ON COLUMN support_read_surfaces.domain IS 'pd:none — metadata: access catalog domain';
COMMENT ON COLUMN support_read_surfaces.classification_tables IS 'pd:none — metadata: response source tables';
COMMENT ON COLUMN support_read_surfaces.field_classes IS 'pd:none — metadata: reviewed response aliases and classifications';
COMMENT ON COLUMN support_read_surfaces.feature IS 'pd:none — metadata: Cedar read action';

INSERT INTO realtime_topic_map(target_type,action,resource_type,carries_id)
SELECT 'support_sessions','support.'||a,'support_session',false FROM unnest(ARRAY['request','operator_approve','approve','deny','start','end','expire','access']) a;

COMMENT ON TABLE support_sessions IS 'Tenant-partitioned support access ledger; platform may select metadata only';
COMMENT ON TABLE support_session_decisions IS 'Tenant decisions and vendor references; append only';
COMMENT ON COLUMN support_sessions.org_id IS 'pd:none — metadata: target partition';
COMMENT ON COLUMN support_sessions.id IS 'pd:none — metadata: opaque session reference';
COMMENT ON COLUMN support_sessions.operator_ref IS 'pd:none — metadata: opaque vendor reference';
COMMENT ON COLUMN support_sessions.operator_label IS 'pd:none — metadata: vendor name and opaque operator reference';
COMMENT ON COLUMN support_sessions.ticket_ref IS 'pd:undeclared — content: customer ticket reference';
COMMENT ON COLUMN support_sessions.reason_code IS 'pd:none — metadata: support reason code';
COMMENT ON COLUMN support_sessions.reason IS 'pd:undeclared — content: stated reason';
COMMENT ON COLUMN support_sessions.scope IS 'pd:none — metadata: approved domains';
COMMENT ON COLUMN support_sessions.mode IS 'pd:none — metadata: read only';
COMMENT ON COLUMN support_sessions.masked IS 'pd:none — metadata: masking status';
COMMENT ON COLUMN support_sessions.reveal_classes IS 'pd:none — metadata: tenant approved field classes';
COMMENT ON COLUMN support_sessions.requested_duration_seconds IS 'pd:none — metadata: requested duration';
COMMENT ON COLUMN support_sessions.approved_duration_seconds IS 'pd:none — metadata: tenant duration';
COMMENT ON COLUMN support_sessions.state IS 'pd:none — metadata: lifecycle state';
COMMENT ON COLUMN support_sessions.requested_at IS 'pd:none — metadata: requested time';
COMMENT ON COLUMN support_sessions.request_expires_at IS 'pd:none — metadata: unanswered request deadline';
COMMENT ON COLUMN support_sessions.operator_approver_ref IS 'pd:none — metadata: second opaque vendor reference';
COMMENT ON COLUMN support_sessions.operator_approved_at IS 'pd:none — metadata: second operator approval time';
COMMENT ON COLUMN support_sessions.tenant_approver_ref IS 'pd:personal — content: tenant approval account';
COMMENT ON COLUMN support_sessions.tenant_approved_at IS 'pd:none — metadata: tenant approval time';
COMMENT ON COLUMN support_sessions.started_at IS 'pd:none — metadata: session start';
COMMENT ON COLUMN support_sessions.expires_at IS 'pd:none — metadata: session deadline';
COMMENT ON COLUMN support_sessions.ended_at IS 'pd:none — metadata: session end';
COMMENT ON COLUMN support_sessions.request_assertion IS 'pd:none — metadata: bound request assertion';
COMMENT ON COLUMN support_sessions.approval_assertion IS 'pd:none — metadata: bound second operator assertion';
COMMENT ON COLUMN support_session_decisions.org_id IS 'pd:none — metadata: partition';
COMMENT ON COLUMN support_session_decisions.id IS 'pd:none — metadata: decision reference';
COMMENT ON COLUMN support_session_decisions.session_id IS 'pd:none — metadata: session reference';
COMMENT ON COLUMN support_session_decisions.actor_ref IS 'pd:personal — content: tenant account or opaque vendor reference';
COMMENT ON COLUMN support_session_decisions.actor_label IS 'pd:personal — content: resolvable actor label';
COMMENT ON COLUMN support_session_decisions.decision IS 'pd:none — metadata: decision kind';
COMMENT ON COLUMN support_session_decisions.at IS 'pd:none — metadata: decision time';

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
        ('attendance.late.grace_minutes', 'int', 0::BIGINT, 60::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('ops_recovery.hold_hours', 'int', 24::BIGINT, 168::BIGINT, 72::BIGINT, 'lower', 'platform_only', NULL::TEXT[]),
        ('ops_recovery.code_ttl_minutes', 'int', 5::BIGINT, 10::BIGINT, 10::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('display.page_size', 'int', 1::BIGINT, 500::BIGINT, 100::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('support.request_expiry', 'int', 1::BIGINT, 12::BIGINT, 12::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('support.max_duration', 'int', 1::BIGINT, 4::BIGINT, 4::BIGINT, 'higher', 'platform_only', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

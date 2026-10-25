-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand-only governed erasure; old command callers fail closed.
SET LOCAL lock_timeout = '2s';
-- Verified proof time belongs to the database, including after a lock wait.
ALTER TABLE step_up_assertions ALTER COLUMN asserted_at SET DEFAULT clock_timestamp();
REVOKE INSERT ON step_up_assertions FROM console_rt;
GRANT INSERT(ceremony_id,org_id,user_id,credential_row_id,action_kind,object_id,payload_hash,user_verified)
    ON step_up_assertions TO console_rt;
-- console-gate: audited-table tenant_erase_requests
CREATE TABLE tenant_erase_requests (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id UUID PRIMARY KEY,
    target_org_id UUID NOT NULL,
    requested_by UUID NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    open_assertion UUID NOT NULL UNIQUE,
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    approve_assertion UUID UNIQUE,
    cooling_until TIMESTAMPTZ,
    cancelled_by UUID,
    cancelled_at TIMESTAMPTZ,
    erased_at TIMESTAMPTZ,
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
    CHECK ((approved_by IS NULL) = (approve_assertion IS NULL)),
    CHECK ((approved_by IS NULL) = (cooling_until IS NULL)),
    CHECK (cooling_until IS NULL OR cooling_until > approved_at),
    CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL)),
    CHECK (erased_at IS NULL OR (approved_at IS NOT NULL AND erased_at >= cooling_until AND cancelled_at IS NULL))
);
CREATE UNIQUE INDEX tenant_erase_one_open ON tenant_erase_requests(target_org_id)
    WHERE cancelled_at IS NULL AND erased_at IS NULL;
ALTER TABLE tenant_erase_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_erase_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_erase_requests
    USING (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid)
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
REVOKE ALL ON tenant_erase_requests FROM PUBLIC,console_rt,console_platform_force_cmd;
GRANT SELECT,INSERT ON tenant_erase_requests TO console_rt;
GRANT UPDATE(approved_by,approved_at,approve_assertion,cooling_until,cancelled_by,cancelled_at)
    ON tenant_erase_requests TO console_rt;
COMMENT ON TABLE tenant_erase_requests IS 'Platform-owned immutable target receipt; target deliberately survives tenant deletion';
COMMENT ON COLUMN tenant_erase_requests.org_id IS 'pd:none — tenant erasure org_id';
COMMENT ON COLUMN tenant_erase_requests.id IS 'pd:none — tenant erasure id';
COMMENT ON COLUMN tenant_erase_requests.target_org_id IS 'pd:none — tenant erasure target_org_id';
COMMENT ON COLUMN tenant_erase_requests.requested_by IS 'pd:personal — tenant erasure requested_by';
COMMENT ON COLUMN tenant_erase_requests.opened_at IS 'pd:none — tenant erasure opened_at';
COMMENT ON COLUMN tenant_erase_requests.open_assertion IS 'pd:none — tenant erasure open_assertion';
COMMENT ON COLUMN tenant_erase_requests.approved_by IS 'pd:personal — tenant erasure approved_by';
COMMENT ON COLUMN tenant_erase_requests.approved_at IS 'pd:none — tenant erasure approved_at';
COMMENT ON COLUMN tenant_erase_requests.approve_assertion IS 'pd:none — tenant erasure approve_assertion';
COMMENT ON COLUMN tenant_erase_requests.cooling_until IS 'pd:none — tenant erasure cooling_until';
COMMENT ON COLUMN tenant_erase_requests.cancelled_by IS 'pd:personal — tenant erasure cancelled_by';
COMMENT ON COLUMN tenant_erase_requests.cancelled_at IS 'pd:none — tenant erasure cancelled_at';
COMMENT ON COLUMN tenant_erase_requests.erased_at IS 'pd:none — tenant erasure erased_at';

CREATE FUNCTION tenant_erase_proof(p_actor UUID,p_assertion UUID,p_target UUID,p_id UUID,p_action TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT EXISTS(SELECT 1 FROM step_up_assertions s JOIN users u ON u.id=s.user_id
        JOIN auth_webauthn_credentials c ON c.id=s.credential_row_id AND c.user_id=u.id
        WHERE s.ceremony_id=p_assertion AND s.user_id=p_actor AND u.is_active
        AND u.org_id='00000000-0000-0000-0000-00000000face'::uuid
        AND 'SUPER_ADMIN'=ANY(u.roles) AND s.org_id=u.org_id
        AND s.action_kind='OPERATOR_RECOVERY' AND s.object_id=p_id AND s.user_verified
        AND s.payload_hash=encode(digest('tenant_erase:'||p_target||':'||p_id||':'||p_action,'sha256'),'hex'))
$$;
REVOKE ALL ON FUNCTION tenant_erase_proof(UUID,UUID,UUID,UUID,TEXT) FROM PUBLIC;
CREATE FUNCTION tenant_erase_request_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE hours BIGINT;
BEGIN
    IF TG_OP='UPDATE' AND (OLD.cancelled_at IS NOT NULL OR OLD.erased_at IS NOT NULL) AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'closed tenant erasure request is immutable' USING ERRCODE='55000';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.approved_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.erased_at IS NOT NULL
           OR NOT tenant_erase_proof(NEW.requested_by,NEW.open_assertion,NEW.target_org_id,NEW.id,'open') THEN
            RAISE EXCEPTION 'tenant erasure requires bound operator proof' USING ERRCODE='42501';
        END IF;
    ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approve_assertion IS DISTINCT FROM OLD.approve_assertion OR NEW.cooling_until IS DISTINCT FROM OLD.cooling_until THEN
        IF OLD.approved_by IS NOT NULL OR OLD.cancelled_at IS NOT NULL OR OLD.erased_at IS NOT NULL
           OR NEW.approved_by=NEW.requested_by
           OR NOT tenant_erase_proof(NEW.approved_by,NEW.approve_assertion,NEW.target_org_id,NEW.id,'approve') THEN
            RAISE EXCEPTION 'tenant erasure requires second operator proof' USING ERRCODE='42501';
        END IF;
        IF NEW.approved_at < (SELECT asserted_at FROM step_up_assertions WHERE ceremony_id=NEW.approve_assertion)
           OR NEW.approved_at > clock_timestamp() THEN
            RAISE EXCEPTION 'tenant erasure approval time must follow its proof' USING ERRCODE='23514';
        END IF;
        SELECT COALESCE((SELECT (value #>> '{}')::bigint FROM platform_setting_overrides
            WHERE key='platform.tenant_erase_cooling' AND effective_from<=NEW.approved_at ORDER BY effective_from DESC LIMIT 1),
            (SELECT default_ordinal FROM setting_definition('platform.tenant_erase_cooling'))) INTO hours;
        IF hours IS NULL OR NEW.cooling_until < NEW.approved_at + make_interval(hours=>hours::int) THEN
            RAISE EXCEPTION 'tenant erasure cooling policy required' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tenant_erase_request_guard() FROM PUBLIC;
CREATE TRIGGER tenant_erase_request_guard BEFORE INSERT OR UPDATE ON tenant_erase_requests
    FOR EACH ROW EXECUTE FUNCTION tenant_erase_request_guard();
INSERT INTO realtime_topic_map(target_type,action,resource_type,carries_id) VALUES
    ('tenant_erase_request','platform.tenant.erase.open','tenant_erase',true),
    ('tenant_erase_request','platform.tenant.erase.approve','tenant_erase',true),
    ('tenant_erase_request','platform.tenant.erase.cancel','tenant_erase',true),
    ('tenant_erase_request','platform.tenant.erase.run','tenant_erase',true);
CREATE OR REPLACE FUNCTION platform_force_remove_organization_command(
    p_id UUID, p_actor UUID, p_trace_id CHAR(32), p_span_id CHAR(16), p_occurred_at TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_slug TEXT;
    v_name TEXT;
    v_outcome TEXT;
    v_wiped JSONB;
    v_request tenant_erase_requests%ROWTYPE;
    v_status TEXT;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SET LOCAL row_security = off;
    -- Lock both operators before tenant accounts, then the organization and request.
    PERFORM id FROM users WHERE id IN (
        SELECT requested_by FROM tenant_erase_requests WHERE target_org_id=p_id AND cancelled_at IS NULL AND erased_at IS NULL
        UNION SELECT approved_by FROM tenant_erase_requests WHERE target_org_id=p_id AND cancelled_at IS NULL AND erased_at IS NULL
    ) ORDER BY id FOR NO KEY UPDATE;
    PERFORM platform_lock_organization_accounts_for_removal(p_id);
    IF EXISTS (SELECT 1 FROM docs_evidence_legal_holds WHERE org_id = p_id AND status = 'ACTIVE') THEN
        INSERT INTO audit_events (org_id, actor, action, target_type, target_id,
            after_snap, trace_id, span_id, occurred_at,
            principal_type, actor_kind, source, outcome, command_id)
        VALUES (p_id, p_actor, 'platform.tenant.force_remove.refused', 'organizations', p_id::text,
            jsonb_build_object('reason_code', 'blocked_legal_hold'), p_trace_id, p_span_id, p_occurred_at,
            'SUPPORT_OPERATOR', 'SUPPORT_OPERATOR', 'API', 'DENIED', gen_random_uuid());
        RETURN 'blocked_legal_hold';
    END IF;
    SELECT slug,name,status INTO v_slug,v_name,v_status FROM organizations WHERE id=p_id;
    IF v_slug IS NULL OR v_slug='platform' THEN RETURN 'not_found'; END IF;
    IF v_status<>'ARCHIVED' THEN RETURN 'blocked_active'; END IF;
    SELECT * INTO v_request FROM tenant_erase_requests
        WHERE target_org_id=p_id AND cancelled_at IS NULL AND erased_at IS NULL FOR UPDATE;
    IF v_request.approved_by IS NULL THEN RETURN 'erase_requires_second_operator'; END IF;
    IF v_request.approved_by=v_request.requested_by THEN RETURN 'erase_same_operator'; END IF;
    IF p_actor IS DISTINCT FROM v_request.approved_by
       OR NOT tenant_erase_proof(v_request.requested_by,v_request.open_assertion,p_id,v_request.id,'open')
       OR NOT tenant_erase_proof(v_request.approved_by,v_request.approve_assertion,p_id,v_request.id,'approve') THEN
        RETURN 'erase_requires_second_operator';
    END IF;
    v_now := clock_timestamp();
    IF v_now<v_request.cooling_until THEN RETURN 'erase_cooling'; END IF;
    SELECT jsonb_build_object(
        'users', (SELECT count(*) FROM users WHERE org_id = p_id),
        'registry_customers', (SELECT count(*) FROM registry_customers WHERE org_id = p_id),
        'registry_sites', (SELECT count(*) FROM registry_sites WHERE org_id = p_id),
        'registry_equipment', (SELECT count(*) FROM registry_equipment WHERE org_id = p_id),
        'work_orders', (SELECT count(*) FROM work_orders WHERE org_id = p_id),
        'financial_rental_quotes', (SELECT count(*) FROM financial_rental_quotes WHERE org_id = p_id),
        'financial_purchase_requests', (SELECT count(*) FROM financial_purchase_requests WHERE org_id = p_id),
        'messenger_threads', (SELECT count(*) FROM messenger_threads WHERE org_id = p_id),
        'evidence_media', (SELECT count(*) FROM evidence_media WHERE org_id = p_id),
        'audit_events', (SELECT count(*) FROM audit_events WHERE org_id = p_id)
    ) INTO v_wiped;
    v_outcome := platform_force_remove_organization(p_id);
    IF v_outcome <> 'removed' THEN
        RETURN v_outcome;
    END IF;
    INSERT INTO audit_events (
        org_id, actor, action, target_type, target_id, branch_id,
        before_snap, after_snap, trace_id, span_id, occurred_at
    ) VALUES (
        NULL, p_actor, 'platform.tenant.force_remove', 'organizations', p_id::text, NULL,
        jsonb_build_object('org_id', p_id, 'slug', v_slug, 'name', v_name, 'wiped', v_wiped), NULL,
        p_trace_id, p_span_id, p_occurred_at
    );
    UPDATE tenant_erase_requests SET erased_at=v_now WHERE id=v_request.id;
    INSERT INTO audit_events(org_id,actor,action,target_type,target_id,after_snap,trace_id,span_id,occurred_at)
    VALUES(v_request.org_id,p_actor,'platform.tenant.erase.run','tenant_erase_request',v_request.id::text,
        jsonb_build_object('target_org_id',p_id),p_trace_id,p_span_id,v_now);
    RETURN 'removed';
END;
$$;
REVOKE ALL ON FUNCTION platform_force_remove_organization_command(UUID, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ) FROM PUBLIC, console_rt;
GRANT EXECUTE ON FUNCTION platform_force_remove_organization_command(UUID, UUID, CHAR(32), CHAR(16), TIMESTAMPTZ) TO console_platform_force_cmd;
REVOKE EXECUTE ON FUNCTION platform_force_remove_organization(UUID) FROM console_platform_force_cmd;

CREATE FUNCTION platform_run_due_tenant_erases() RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r RECORD; result TEXT; erased BIGINT:=0;
BEGIN
    SET LOCAL row_security=off;
    FOR r IN SELECT target_org_id,approved_by FROM tenant_erase_requests
        WHERE approved_by IS NOT NULL AND cancelled_at IS NULL AND erased_at IS NULL
        AND cooling_until<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM docs_evidence_legal_holds h WHERE h.org_id=target_org_id AND h.status='ACTIVE')
        ORDER BY cooling_until,id
    LOOP
        result:=platform_force_remove_organization_command(r.target_org_id,r.approved_by,
            replace(gen_random_uuid()::text,'-','')::char(32),left(replace(gen_random_uuid()::text,'-',''),16)::char(16),clock_timestamp());
        IF result='removed' THEN erased:=erased+1; END IF;
    END LOOP;
    RETURN erased;
END $$;
REVOKE ALL ON FUNCTION platform_run_due_tenant_erases() FROM PUBLIC,console_rt;
GRANT EXECUTE ON FUNCTION platform_run_due_tenant_erases() TO console_platform_force_cmd;

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
        ('action_inbox.source_concurrency', 'int', 1::BIGINT, 8::BIGINT, 4::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('attendance.excess.notice_minutes', 'int', 0::BIGINT, 30::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('attendance.entry.long_span_confirm_minutes', 'int', 1::BIGINT, 1440::BIGINT, 960::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('attendance.late.grace_minutes', 'int', 0::BIGINT, 60::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('platform.tenant_erase_cooling', 'int', 24::BIGINT, 168::BIGINT, 72::BIGINT, 'lower', 'platform_only', NULL::TEXT[]),
        ('ops_recovery.hold_hours', 'int', 24::BIGINT, 168::BIGINT, 72::BIGINT, 'lower', 'platform_only', NULL::TEXT[]),
        ('ops_recovery.code_ttl_minutes', 'int', 5::BIGINT, 10::BIGINT, 10::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('hr.contract_soon_days', 'int', 1::BIGINT, 365::BIGINT, 60::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('display.page_size', 'int', 1::BIGINT, 500::BIGINT, 100::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('support.request_expiry', 'int', 1::BIGINT, 12::BIGINT, 12::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('support.max_duration', 'int', 1::BIGINT, 4::BIGINT, 4::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('nts.check.cadence_hours', 'int', 1::BIGINT, 720::BIGINT, 24::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('nts.check.batch_size', 'int', 1::BIGINT, 100::BIGINT, 100::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('nts.check.daily_budget', 'int', 1::BIGINT, 1000000::BIGINT, 10000::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('nts.check.reflection_lag_days', 'int', 2::BIGINT, 2::BIGINT, 2::BIGINT, 'neutral', 'fixed', NULL::TEXT[]),
        ('nts.check.backoff_seconds', 'int', 60::BIGINT, 86400::BIGINT, 3600::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('orgchange.apply_time', 'int', 0::BIGINT, 1439::BIGINT, 5::BIGINT, 'neutral', 'tenant', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

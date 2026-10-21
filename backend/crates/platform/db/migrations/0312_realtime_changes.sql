-- RT-0 (decisions #27; data-display spec §2.1 A9, §3.2): realtime change log,
-- topic allowlist and the emission trigger. INTEG renumbers to head+1.
--
--   * `audit_events` is written in the same transaction as every audited
--     mutation (0003), so ONE deferred trigger on it covers the Rust paths, the
--     SQL-function paths and the scheduled-apply runner. No domain crate emits.
--   * `realtime_topic_map` is the allowlist: no row, no event. Previews, dry
--     runs, `*.refused`, read audits and `*.snapshot` rows are deliberately
--     absent (a read audit that emitted would make two viewers refetch each
--     other forever).
--   * `resource_changes` is the transactional outbox for realtime. NOTIFY is
--     only the wake-up; the hub re-reads the rows by `(org_id, tx_id)`.
--   * Events are hints: no actor, no field names, no values (spec §3.1).
--
-- Presence and work claims (RT-6/RT-7) are post-MVP (#27) and add their own
-- tables with their routes.

-- ---------------------------------------------------------------------------
-- (1) realtime_topic_map: (audit target_type, action) -> event resource_type.
-- Global vocabulary (tenant-isolation global allowlist). Each lane appends its
-- rows in its own migration. Exact equality, never LIKE.
-- `carries_id = false` emits `resource_id` NULL (the frame's `id: null`: every
-- id of the type) when the audit target is not the aggregate the client
-- caches (a batch, an approval step, a settlement item, an org-unit path).
-- ---------------------------------------------------------------------------
CREATE TABLE realtime_topic_map (
    target_type   TEXT    NOT NULL,
    action        TEXT    NOT NULL CHECK (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
    resource_type TEXT    NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]*$'),
    carries_id    BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (target_type, action, resource_type)
);

REVOKE ALL PRIVILEGES ON realtime_topic_map FROM PUBLIC, console_rt;
GRANT SELECT ON realtime_topic_map TO console_rt;

INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    -- 테넌트: platform tier and onboarding.
    ('organizations', 'platform.tenant.create', 'tenant', false),
    ('organizations', 'platform.tenant.rename', 'tenant', false),
    ('organizations', 'platform.tenant.status', 'tenant', false),
    ('tenant', 'tenant.go_live', 'tenant', false),
    ('tenant', 'tenant.setup_step_skip', 'tenant', false),
    ('tenant', 'tenant.terms_accept', 'tenant', false),
    -- 법인, 사업자등록, 사업장 (entity adapter).
    ('legal_entity', 'legal_entity.create', 'legal_entity', true),
    ('legal_entity', 'legal_entity.revise', 'legal_entity', true),
    ('legal_entity', 'legal_entity.void', 'legal_entity', true),
    ('legal_entity', 'legal_entity.close', 'legal_entity', true),
    ('legal_entity', 'legal_entity.close', 'workplace', false),
    ('legal_entity', 'legal_entity.close', 'business_registration', false),
    ('legal_entity', 'legal_entity.set_roles', 'legal_entity', true),
    ('legal_entity', 'legal_entity.correct_identifier', 'legal_entity', true),
    ('legal_entity', 'employment_assignment.map_company', 'legal_entity', true),
    ('legal_entity', 'employment_assignment.map_company', 'employee', false),
    ('business_registration', 'business_registration.create', 'business_registration', true),
    ('business_registration', 'business_registration.revise', 'business_registration', true),
    ('business_registration', 'business_registration.void', 'business_registration', true),
    ('business_registration', 'business_registration.correct_identifier', 'business_registration', true),
    ('workplace', 'workplace.create', 'workplace', true),
    ('workplace', 'workplace.revise', 'workplace', true),
    ('workplace', 'workplace.void', 'workplace', true),
    ('workplace', 'workplace.change_registration', 'workplace', true),
    ('workplace', 'workplace.insurance', 'workplace', true),
    ('workplace', 'workplace.insurance.revise', 'workplace', true),
    ('entity_setup_batch', 'entity_setup.apply', 'entity_setup_batch', true),
    ('entity_setup_batch', 'entity_setup.undo', 'entity_setup_batch', true),
    -- 부서 setup and org changes.
    ('org_unit', 'org_unit.setup_create', 'org_unit', true),
    ('org_unit', 'org_unit.setup_rename', 'org_unit', true),
    ('org_unit', 'org_change.apply.op', 'org_unit', false),
    ('branch', 'org_change.apply.op', 'org_unit', false),
    ('region', 'org_change.apply.op', 'org_unit', false),
    ('site', 'org_change.apply.op', 'org_unit', false),
    ('org_change_request', 'org_change.create', 'org_change', true),
    ('org_change_request', 'org_change.draft.update', 'org_change', true),
    ('org_change_request', 'org_change.submit', 'org_change', true),
    ('org_change_request', 'org_change.effectuate', 'org_change', true),
    ('org_change_request', 'org_change.archive', 'org_change', true),
    ('org_change_request', 'org_change.cancel', 'org_change', true),
    ('org_change_approval_step', 'org_change.step.decide', 'org_change', false),
    ('org_change_settlement_item', 'org_change.settlement.complete', 'org_change', false),
    -- Employees: directory, facts, 인사카드, lifecycle, placement.
    ('employee', 'employee.create', 'employee', true),
    ('employee', 'employee.correct', 'employee', true),
    ('employee', 'employee.facts.update', 'employee', true),
    ('employee', 'employee.contract.record', 'employee', true),
    ('employee', 'employee.probation.confirm', 'employee', true),
    ('employee', 'employee.identity_resolve', 'employee', true),
    ('employee', 'employee.record.create', 'employee', true),
    ('employee', 'employee.record.update', 'employee', true),
    ('employee', 'employee.record.void', 'employee', true),
    ('employee', 'employee.record.import', 'employee', true),
    ('person_record_import_batch', 'employee.record.import_batch', 'employee', false),
    ('employee', 'employee.lifecycle.record', 'employee', true),
    ('employee', 'employee.lifecycle.schedule', 'employee', true),
    ('employee', 'employee.lifecycle.cancel', 'employee', true),
    ('employee', 'employee.lifecycle.apply', 'employee', true),
    ('employee', 'employee.lifecycle.apply_failed', 'employee', true),
    ('employee_lifecycle_batch', 'employee.lifecycle.bulk', 'employee', false),
    ('employee', 'employment_assignment.bind', 'employee', true),
    -- Exit: the report targets the employee and opens a case; the
    -- transitions target the case.
    ('employee', 'employee.exit.report', 'employee', true),
    ('employee', 'employee.exit.report', 'exit_case', false),
    ('employee_exit_case', 'employee.exit.confirm', 'exit_case', true),
    ('employee_exit_case', 'employee.exit.reject', 'exit_case', true),
    ('employee_exit_case', 'employee.exit.cancel', 'exit_case', true),
    ('employee_exit_case', 'employee.exit.approval_draft', 'exit_case', true),
    -- Change requests (정정 요청).
    ('change_request', 'change_request.create', 'change_request', true),
    ('change_request', 'change_request.decide', 'change_request', true),
    -- Imports: the run (or a run-less batch) plus the employees it wrote.
    ('data_import_run', 'data_import.apply', 'import_run', true),
    ('data_import_run', 'data_import.apply', 'employee', false),
    ('employee_import_batch', 'data_import.apply', 'import_run', false),
    ('employee_import_batch', 'data_import.apply', 'employee', false),
    ('data_import_run', 'attendance_import.apply', 'import_run', true),
    -- Accounts and tenant roles.
    ('user', 'user.create', 'user', true),
    ('user', 'user.update', 'user', true),
    ('user', 'user.update_self', 'user', true),
    ('user', 'user.activate', 'user', true),
    ('user', 'user.deactivate', 'user', true),
    ('user', 'user.workspace_update', 'user', true),
    ('policy_role', 'policy.role.create', 'role', true),
    ('policy_role', 'policy.role.update', 'role', true),
    ('policy_role', 'policy.role.status_update', 'role', true),
    ('policy_role_assignment', 'policy.role_assignment.replace', 'user', true),
    ('policy_role_assignment', 'policy.role_assignment.replace', 'role', false),
    -- Audited writes that reached trunk after this lane
    -- branched (CRUD ends, structure setup, 사번, registration void, the
    -- access model, exits ending access).
    ('org_unit', 'org_unit.setup_move', 'org_unit', true),
    ('org_unit', 'org_unit.setup_details', 'org_unit', true),
    ('org_unit', 'org_unit.setup_dissolve', 'org_unit', true),
    ('org_unit', 'org_unit.setup_revert', 'org_unit', true),
    ('org_unit', 'org_unit.erase', 'org_unit', true),
    ('org_unit', 'org_structure.reorder', 'org_unit', false),
    ('workplace', 'org_structure.reorder', 'org_unit', false),
    ('legal_entity', 'org_structure.reorder', 'org_unit', false),
    ('workplace', 'workplace.code', 'workplace', true),
    ('workplace', 'workplace.kind', 'workplace', true),
    ('employee', 'employee.rehire', 'employee', true),
    ('employee', 'employee.lifecycle.correct', 'employee', true),
    ('employee', 'employee.lifecycle.rescind', 'employee', true),
    ('employee_lifecycle_batch', 'employee.lifecycle.bulk_rescind', 'employee', false),
    ('employee', 'employee.employee_number_change', 'employee', true),
    ('employee_renumber_batch', 'employee.renumber_apply', 'employee', false),
    ('employee_renumber_batch', 'employee.renumber_undo', 'employee', false),
    ('employee', 'employee.register_facts.bulk_correct', 'employee', false),
    ('employee_correction_batch', 'employee.correct.bulk', 'employee', false),
    ('employee', 'employee.photo.upload_confirm', 'employee', true),
    ('employee', 'employee.void_request', 'employee', true),
    ('employee', 'employee.void', 'employee', true),
    ('employee', 'employee.setup_delete', 'employee', true),
    ('employee', 'employee.pii_destroyed', 'employee', true),
    ('data_import_run', 'employee.import.settle', 'import_run', true),
    ('data_import_run', 'employee.import.settle', 'employee', false),
    ('data_import_run', 'data_import.signoff', 'import_run', true),
    ('access_roles', 'access.role.create', 'role', true),
    ('access_roles', 'access.role.update', 'role', true),
    ('access_roles', 'access.role.status', 'role', true),
    ('access_roles', 'access.role.delete', 'role', true),
    ('access_grant_receipts', 'access.grants.apply', 'role', false),
    ('access_grant_receipts', 'access.grants.apply', 'user', false),
    ('user', 'user.access.end_on_exit', 'user', true),
    -- UX-R1 ENTITY (on trunk since 2f266001): a closed 법인's 종료 정정.
    ('legal_entity', 'legal_entity.close_correct', 'legal_entity', true),
    ('legal_entity', 'legal_entity.close_correct', 'workplace', false),
    ('legal_entity', 'legal_entity.close_correct', 'business_registration', false),
    -- UX-R2 ENDS (on trunk since eeaad9de): its 0311 inserts these only when
    -- this table already exists, so on a fresh database they live here.
    ('workplace', 'workplace.close_plan', 'workplace', true),
    ('workplace', 'workplace.close_job.apply', 'workplace', true),
    ('workplace', 'workplace.close_job.wait', 'workplace', true),
    ('workplace', 'workplace.close_job.fail', 'workplace', true),
    ('workplace', 'workplace.close_job.cancel', 'workplace', true),
    ('org_unit', 'org_unit.close_move', 'org_unit', true),
    ('org_unit', 'org_unit.close_dissolve', 'org_unit', true);

-- ---------------------------------------------------------------------------
-- (2) resource_changes: derived, not audited, pruned after
-- `realtime.replay_window` by the hub. Written only by emit_resource_change().
-- `created_at = now()` is the transaction START (the audit clock), which the
-- replay overlap rule depends on. `seq` is assigned at commit (the trigger is
-- deferred), not in commit order, so replay never uses `seq > cursor` alone.
-- No FK to organizations: the deferred insert runs at COMMIT, after a tenant
-- removal's DELETE in the same transaction, and a derived hint must never
-- abort the write it describes.
-- ponytail: a removed tenant's last rows outlive it (the hub prunes per woken
-- tenant); sweep orphans in the force-remove closure if that ever matters.
-- ---------------------------------------------------------------------------
CREATE TABLE resource_changes (
    org_id         UUID        NOT NULL,
    seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
    tx_id          XID8        NOT NULL DEFAULT pg_current_xact_id(),
    audit_event_id UUID        NOT NULL,
    resource_type  TEXT        NOT NULL,
    resource_id    TEXT        NULL,
    branch_id      UUID        NULL,
    ver            TEXT        NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, seq)
);
CREATE INDEX idx_resource_changes_tx ON resource_changes (org_id, tx_id);
CREATE INDEX idx_resource_changes_created ON resource_changes (org_id, created_at);

ALTER TABLE resource_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON resource_changes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- The runtime reads and prunes; it never writes events itself.
REVOKE ALL PRIVILEGES ON resource_changes FROM PUBLIC, console_rt;
GRANT SELECT, DELETE ON resource_changes TO console_rt;

-- ---------------------------------------------------------------------------
-- (3) emit_resource_change(): deferred, so it runs at commit and a rollback
-- emits nothing. SECURITY DEFINER: the owner (console_app, BYPASSRLS since
-- 0196) inserts whatever `app.current_org` holds, so a deferred insert can
-- never abort the business transaction at commit.
--
-- Migrator skip (spec F16): migrations run with no transaction_timeout, so
-- an audit row written by one could break the replay overlap. Test
-- SESSION_USER, never CURRENT_USER (inside SECURITY DEFINER it is the owner).
-- The runtime logs in as console_rt or a command role, never console_app;
-- sqlx tests log in as the superuser and still emit.
--
-- The NOTIFY payload `{org, tx}` is identical for every row of a transaction,
-- and Postgres folds duplicate payloads within a transaction: one wake per
-- transaction. `tx` is the xid8 as decimal text.
-- ponytail: NOTIFY at commit takes a database-wide lock that serializes
-- committing notifiers (fine at HR write rates, estimate). If audited-commit
-- latency rises, drop pg_notify and let the hub poll resource_changes.
-- ponytail: `ver` stays NULL until lanes stamp `content_rev` into their audit
-- snapshots; a CREATE OR REPLACE then fills it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_resource_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.org_id IS NULL OR SESSION_USER = 'console_app' THEN
        RETURN NULL;
    END IF;

    INSERT INTO resource_changes (org_id, audit_event_id, resource_type, resource_id, branch_id)
    SELECT NEW.org_id,
           NEW.id,
           m.resource_type,
           CASE WHEN m.carries_id THEN NEW.target_id END,
           NEW.branch_id
    FROM realtime_topic_map m
    WHERE m.target_type = NEW.target_type
      AND m.action = NEW.action;

    IF FOUND THEN
        PERFORM pg_notify(
            'resource_changed',
            json_build_object('org', NEW.org_id, 'tx', pg_current_xact_id()::text)::text
        );
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION emit_resource_change() FROM PUBLIC;

-- Never run SET CONSTRAINTS ... IMMEDIATE against this trigger: it would emit
-- before commit. Disabling it is refused by migration-safety's
-- DisableAuditEventsTrigger check.
CREATE CONSTRAINT TRIGGER trg_audit_events_resource_change
    AFTER INSERT ON audit_events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION emit_resource_change();

-- ---------------------------------------------------------------------------
-- (4) Personal-data classification (0211 vocabulary).
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN realtime_topic_map.target_type IS 'pd:none — audit target type vocabulary';
COMMENT ON COLUMN realtime_topic_map.action IS 'pd:none — audit action code vocabulary';
COMMENT ON COLUMN realtime_topic_map.resource_type IS 'pd:none — realtime event type vocabulary';
COMMENT ON COLUMN realtime_topic_map.carries_id IS 'pd:none — whether the event names the record';
COMMENT ON COLUMN resource_changes.org_id IS 'pd:none — structural or non-personal attribute of a non-person row';
COMMENT ON COLUMN resource_changes.seq IS 'pd:none — event sequence (stream cursor)';
COMMENT ON COLUMN resource_changes.tx_id IS 'pd:none — writing transaction id';
COMMENT ON COLUMN resource_changes.audit_event_id IS 'pd:none — audit row that produced the event';
COMMENT ON COLUMN resource_changes.resource_type IS 'pd:none — realtime event type';
COMMENT ON COLUMN resource_changes.resource_id IS 'pd:undeclared — 다형 참조 - 정보주체를 가리킬 수 있음 (audit_events.target_id 복사)';
COMMENT ON COLUMN resource_changes.branch_id IS 'pd:none — structural or non-personal attribute of a non-person row';
COMMENT ON COLUMN resource_changes.ver IS 'pd:none — opaque aggregate revision token';
COMMENT ON COLUMN resource_changes.created_at IS 'pd:none — transaction start time';

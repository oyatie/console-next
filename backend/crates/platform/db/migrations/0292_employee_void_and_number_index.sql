-- PEOPLE-A MR-26 (등록 취소 and the tombstone) and MR-28 (tenant-unique 사번).
-- Numbered head+1 of this lane's stack (IMPORT 0274/0275, the ported MR-8
-- 0276); INTEG renumbers it at the batch merge (tools/integ/renumber-
-- migrations.sh, which also rewrites the include_str! in
-- crates/settings/domain/tests/sql_definitions.rs). No seed rows.
--
-- 0256 is "the one MVP migration that changes employees"; it deferred the
-- (org_id, employee_number) unique index to its own migration after the
-- BW-10 duplicate listing (0274). This is that migration. The void columns
-- ride along because the index must know a legacy duplicate apart from a
-- clean holder, and a void keeps its 사번 (decisions #6: never reused).
--
-- 1. VOIDED. A record that should never have existed (onboarding design
--    §7.3) leaves every read: a RESTRICTIVE policy hides it from the runtime
--    role unless a transaction sets app.include_voided = 'on' (the void
--    writer, the 사번 holder checks and the 「취소된 등록」 list do, for one
--    statement). FK checks and the unique index still see it. No lifecycle
--    event: a void is not a 발령, and the lifecycle to_status list is
--    unchanged.
-- 2. The tombstone. employee_void_destroy_pii() keeps ids, 사번 (released
--    only for a SETUP delete, which nothing can have referenced), dates,
--    status and the void facts (a freed 사번 also frees its source_key),
--    and destroys the rest: the head's personal
--    columns, the profile's pay and phone, the correction ledger's values and
--    the person's legal_name history (PIPA §21; 표준 개인정보 보호지침 §10).
--    It refuses anything but a VOIDED record: the 3-year 근로자 명부
--    disposal (근로기준법 §42, 시행령 §22②1) is GOV-AUD's governed
--    retention job, never automatic (decisions #10).
-- 3. 0213's person-revision immutability admits one narrow UPDATE: the
--    attributes and receipt of a person no live employee record names, while
--    the destroy function runs (app.pii_destruction = 'on').
-- 4. MR-28. Every 사번 group with more than one holder keeps its oldest
--    holder (created_at, id) in the index; the others are flagged
--    employee_number_legacy_duplicate and listed (0274) until a 사번 정정
--    (MR-8) clears the flag. Only this migration ever sets the flag.
-- 5. change_requests learns EMPLOYEE_VOID (the second person's decision).
-- 6. Settings: people.void_window, people.void_pii_retention.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. VOIDED and its facts.
ALTER TABLE employees DROP CONSTRAINT employees_employment_status_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_status_check
    CHECK (employment_status IN ('PRE_HIRE', 'ACTIVE', 'ON_LEAVE', 'EXITED', 'UNKNOWN', 'VOIDED'));

ALTER TABLE employees
    ADD COLUMN voided_at TIMESTAMPTZ NULL,
    ADD COLUMN voided_by UUID NULL,
    ADD COLUMN void_reason_code TEXT NULL
        CONSTRAINT employees_void_reason_code_shape CHECK (char_length(btrim(void_reason_code)) BETWEEN 1 AND 100),
    ADD COLUMN void_mode TEXT NULL
        CONSTRAINT employees_void_mode_check CHECK (void_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER')),
    ADD COLUMN pii_destroyed_at TIMESTAMPTZ NULL,
    ADD COLUMN employee_number_legacy_duplicate BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT employees_void_shape CHECK (
        (employment_status = 'VOIDED') = (voided_at IS NOT NULL)
        AND (voided_at IS NULL) = (voided_by IS NULL)
        AND (voided_at IS NULL) = (void_reason_code IS NULL)
        AND (voided_at IS NULL) = (void_mode IS NULL)
        AND (pii_destroyed_at IS NULL OR voided_at IS NOT NULL)),
    ADD CONSTRAINT employees_voided_by_fk
        FOREIGN KEY (voided_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT;

CREATE INDEX employees_voided_pii_due_idx
    ON employees (org_id, voided_at) WHERE voided_at IS NOT NULL AND pii_destroyed_at IS NULL;

CREATE POLICY hide_voided ON employees AS RESTRICTIVE
    USING (voided_at IS NULL OR current_setting('app.include_voided', true) = 'on');

-- ---------------------------------------------------------------------------
-- 2. The tombstone.
CREATE OR REPLACE FUNCTION canonical_person_row_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'person_revisions' AND TG_OP = 'UPDATE'
       AND current_setting('app.pii_destruction', true) = 'on'
       AND (NEW.org_id, NEW.id, NEW.person_id, NEW.version, NEW.command_id, NEW.actor_id,
            NEW.payload_digest, NEW.created_at)
           IS NOT DISTINCT FROM
           (OLD.org_id, OLD.id, OLD.person_id, OLD.version, OLD.command_id, OLD.actor_id,
            OLD.payload_digest, OLD.created_at) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'canonical person table %: % is refused, the row is immutable',
        TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE FUNCTION employee_void_destroy_pii(p_employee UUID, p_release_number BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org UUID := NULLIF(current_setting('app.current_org', true), '')::uuid;
BEGIN
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'employee tombstone needs an armed tenant';
    END IF;
    PERFORM set_config('app.include_voided', 'on', true);
    PERFORM 1 FROM employees
      WHERE org_id = v_org AND id = p_employee
        AND employment_status = 'VOIDED' AND pii_destroyed_at IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee tombstone refused: % is not a void record with personal data', p_employee;
    END IF;

    UPDATE employees SET
        name = '(파기됨)', org_unit = NULL, job = NULL, position = NULL,
        worksite_name = NULL, worksite_address = NULL, birth_date = NULL,
        work_email = NULL, id_type = NULL, raw_row = '{}'::jsonb,
        employee_number = CASE WHEN p_release_number THEN NULL ELSE employee_number END,
        -- A console registration's source_key is 'console:' || 사번 (0183).
        source_key = CASE WHEN p_release_number THEN 'voided:' || id::text ELSE source_key END,
        pii_destroyed_at = now(), updated_at = now()
     WHERE org_id = v_org AND id = p_employee;
    UPDATE employee_employment_profiles SET
        phone_e164 = NULL, base_pay = NULL, base_pay_won = NULL, pay_unit = NULL,
        contract_start_date = NULL, contract_end_date = NULL, probation_end_date = NULL
     WHERE org_id = v_org AND employee_id = p_employee;
    UPDATE employee_corrections SET old_value = NULL, new_value = 'null'::jsonb
     WHERE org_id = v_org AND employee_id = p_employee;

    -- The person's history, unless another live record names the same person.
    PERFORM set_config('app.pii_destruction', 'on', true);
    UPDATE person_revisions r SET attributes = '{}'::jsonb, receipt = '{}'::jsonb
      FROM employee_person_bindings b
     WHERE b.org_id = v_org AND b.employee_id = p_employee
       AND r.org_id = v_org AND r.person_id = b.person_id
       AND NOT EXISTS (
           SELECT 1 FROM employee_person_bindings o
             JOIN employees e ON e.org_id = o.org_id AND e.id = o.employee_id
            WHERE o.org_id = v_org AND o.person_id = b.person_id
              AND o.employee_id <> p_employee AND e.voided_at IS NULL);
    PERFORM set_config('app.pii_destruction', 'off', true);
    PERFORM set_config('app.include_voided', 'off', true);
END $$;
REVOKE ALL ON FUNCTION employee_void_destroy_pii(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION employee_void_destroy_pii(UUID, BOOLEAN) TO console_rt;

-- ---------------------------------------------------------------------------
-- 4. MR-28: one holder per 사번 per tenant, across every status.
UPDATE employees e SET employee_number_legacy_duplicate = true
  FROM (SELECT id, row_number() OVER (PARTITION BY org_id, employee_number
                                      ORDER BY created_at, id) AS n
          FROM employees
         WHERE employee_number IS NOT NULL AND btrim(employee_number) <> '') d
 WHERE e.id = d.id AND d.n > 1;

CREATE FUNCTION employees_number_duplicate_flag_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.employee_number_legacy_duplicate
       AND (TG_OP = 'INSERT' OR NOT OLD.employee_number_legacy_duplicate) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'employee_number_legacy_duplicate is set only by the MR-28 migration';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_employees_number_duplicate_flag_guard
    BEFORE INSERT OR UPDATE OF employee_number_legacy_duplicate ON employees
    FOR EACH ROW EXECUTE FUNCTION employees_number_duplicate_flag_guard();

CREATE UNIQUE INDEX employees_org_employee_number_key
    ON employees (org_id, employee_number)
    WHERE employee_number IS NOT NULL AND btrim(employee_number) <> ''
      AND NOT employee_number_legacy_duplicate;

-- ---------------------------------------------------------------------------
-- 5. EMPLOYEE_VOID requests (0266's list plus the new kind).
ALTER TABLE change_requests DROP CONSTRAINT IF EXISTS change_requests_kind_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_kind_check
    CHECK (kind IN (
        'PROFILE_CORRECTION', 'IDENTITY_REVIEW', 'ACCESS_REQUEST',
        'SCOPE_ACTION', 'OTHER', 'ACCESS_EXPLANATION', 'POLICY_QUESTION',
        'EMPLOYEE_VOID'
    ));

-- ---------------------------------------------------------------------------
-- 6. Settings. The trigger calls setting_definition() by name at run time
-- (plpgsql), so it can be replaced in this transaction; the generated block
-- stays byte-exact for the sql_definitions pin.
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
        ('people.void_pii_retention', 'int', 0::BIGINT, 30::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

COMMENT ON COLUMN employees.voided_at IS 'pd:none — 등록 취소 시각 (MR-26)';
COMMENT ON COLUMN employees.voided_by IS 'pd:personal — 등록을 취소한 사용자 id';
COMMENT ON COLUMN employees.void_reason_code IS 'pd:none — 등록 취소 사유 코드';
COMMENT ON COLUMN employees.void_mode IS 'pd:none — SETUP, GOVERNED or SOLE_HOLDER';
COMMENT ON COLUMN employees.pii_destroyed_at IS 'pd:none — 개인정보 파기 시각 (tombstone)';
COMMENT ON COLUMN employees.employee_number_legacy_duplicate IS 'pd:none — MR-28: 0277 이전부터 다른 직원과 같은 사번 (사번 정정 전까지 유일성 색인 밖)';

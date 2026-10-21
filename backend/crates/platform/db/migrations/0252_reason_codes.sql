-- BW-07 reason-code catalog (product-wide R2). Numbered head+1 of the lane's
-- base; INTEG renumbers it at the batch merge (tools/integ/renumber-migrations.sh),
-- which also rewrites the include_str! in
-- crates/settings/domain/src/code_lists/tests.rs.
--
-- 1. System codes are code-defined in console-settings-domain (code_lists).
--    system_reason_codes() below is GENERATED from that roster and pinned by
--    a test. No reference rows: the function body is the catalog.
-- 2. reason_codes holds tenant-added codes only, in the T_<32 hex> namespace
--    so a later system code can never collide. No DELETE grant (codes stay
--    resolvable for history); only active and sort may change. System codes
--    are always active.
-- 3. Which code is valid for which command (unknown or inactive -> 422
--    reason_code_invalid; requires_note without a note -> 422
--    reason_note_required) is checked by code_lists::validate_reason in the
--    use case. The DB only checks the stored shape.
--
-- COLUMN CONTRACT (plan §3: the lanes never ALTER these tables for reasons).
-- The existing free-text column IS the note (BW-07: "kept and become the
-- note"); there is no separate reason_note column. A code-only reason stores
-- NULL in the note column, so the NOT NULL notes below become nullable:
-- every reader of those columns must decode Option<String> before a writer
-- stores a code-only reason (readers today: app/src/hr.rs lifecycle rows
-- `comment`, app/src/lifecycle.rs period lock `reason`).
--
--   table                      code column          note column     domain(s)
--   org_change_events          reason_code          reason          org_change_reason, _reject,
--                                                                   _cancel, _withdraw, approval_return
--   org_change_approval_steps  reason_code          memo            org_change_reject, approval_return
--   employee_lifecycle_events  reason_code          comment         lifecycle_transfer, _promote
--                              cancel_reason_code   cancel_reason   lifecycle_cancel
--   employee_exit_cases        closed_reason_code   closed_reason   exit_reject, exit_cancel
--   period_locks               reason_code          reason          period_lock
--                              unlock_reason_code   unlock_reason   period_unlock
--   (user role change, deactivate, credential reset: the reason goes in the
--    audit_events snapshot, so no column; domains role_change, deactivate,
--    credential_reset)
--
-- Not here, by design:
-- - "REJECTED needs a reason_code" on org_change_approval_steps
--   (decisions #3) is APPR's to add WITH the writer change, as
--   CHECK (decision <> 'REJECTED' OR reason_code IS NOT NULL) NOT VALID;
--   adding it now would refuse today's reject path.
-- - The exit report's own reason (exit_reason) column and its insurance
--   mapping are BW-08 (HOLD).
--
-- Frontend catalog labels (FE-RC, keyed <domain>.<code>; OTHER = 기타 everywhere):
--   org_change_reason: NEW_BUSINESS_SITE 신규 사업·거점, CONSOLIDATION 조직 통폐합,
--     WORK_REALLOCATION 업무 재배치, RENAMING 명칭 정비, COMPLIANCE_FINDING 법규·감사 지적
--   org_change_reject: EFFECTIVE_DATE_REVIEW 시행일 재검토, INSUFFICIENT_BASIS 근거 부족,
--     WRONG_TARGET 대상 오류, POLICY_VIOLATION 규정 위반
--   approval_return: NEEDS_SUPPLEMENT 내용 보완 필요, ADD_EVIDENCE 근거 자료 추가,
--     ADJUST_EFFECTIVE_DATE 시행일 조정, CORRECT_TARGET 대상 정정
--   org_change_cancel / org_change_withdraw: DUPLICATE_DRAFT 중복 기안, PLAN_CHANGED 계획 변경,
--     DRAFTING_ERROR 오기재
--   lifecycle_transfer: REGULAR_RESHUFFLE 정기 인사, REORGANIZATION 조직 개편,
--     EMPLOYEE_REQUEST 본인 희망, BUSINESS_NEED 업무 필요
--   lifecycle_promote: REGULAR_PROMOTION 정기 승진, SPECIAL_PROMOTION 특별 승진,
--     DISCIPLINARY_DEMOTION 강등(징계)
--   lifecycle_cancel: INPUT_ERROR 입력 오류, SCHEDULE_CHANGED 일정 변경, PLAN_WITHDRAWN 계획 철회
--   exit_reason: PERSONAL 개인 사정, FAMILY 가사, ILLNESS 질병, STUDY 학업,
--     WORKING_CONDITIONS 근로조건 변동, WAGE_ARREARS 임금체불, RELOCATION 이전, CLOSURE 폐업,
--     INSOLVENCY 도산, ADVISED_RESIGNATION_BUSINESS 권고사직(경영상), REDUNDANCY_DISMISSAL 경영상 해고,
--     DISCIPLINARY_DISMISSAL 징계해고, ADVISED_RESIGNATION_FAULT 권고사직(귀책), RETIREMENT_AGE 정년,
--     CONTRACT_END 계약만료, PROJECT_END 공사종료, COVERAGE_EXCLUDED 적용 제외,
--     DUAL_EMPLOYMENT 이중고용, DEATH 사망
--   exit_reject: EMPLOYEE_WITHDREW 퇴직 철회(본인), NOT_FACTUAL 사실과 다름
--   exit_cancel: EMPLOYEE_WITHDREW 본인 철회, REPORT_ERROR 보고 오류
--   period_lock: MONTHLY_PAYROLL_CLOSE 월 급여 마감, BOOKS_CLOSE 결산 마감, TAX_FILING 세무 신고,
--     AUDIT_RESPONSE 감사 대응
--   period_unlock: RETRO_CORRECTION 소급 정정, PAYROLL_ERROR 급여 오류, AUDIT_FINDING 감사 지적
--   role_change: PROMOTION_OR_REASSIGNMENT 승진·보직 변경, EXIT_OR_LEAVE 퇴직·휴직,
--     ACCESS_CLEANUP 권한 정리, ERROR_CORRECTION 오류 정정
--   deactivate: EXIT 퇴직, LEAVE 휴직, SECURITY_INCIDENT 보안 사고, DUPLICATE_ACCOUNT 중복 계정
--   credential_reset: DEVICE_LOST 기기 분실, DEVICE_REPLACED 기기 교체,
--     COMPROMISE_SUSPECTED 도난·탈취 의심
--   import_exclude: DUPLICATE 중복, FORMAT_ERROR 형식 오류, OUT_OF_SCOPE 대상 아님
--   exception: (OTHER only until F-EXC adds per-rule codes)
--   retained_record_purpose: EMPLOYMENT_CERTIFICATE 사용증명서 발급,
--     SEPARATION_CONFIRMATION 이직확인서 발급, PAYMENT_STATEMENT_FILING 지급명세서 제출,
--     WITHHOLDING_CORRECTION 원천징수·지급명세서 정정, EXIT_PROCESSING_COMPLETION 퇴직 처리 마무리,
--     DISPUTE_OR_INSPECTION 분쟁·근로감독 대응, DATA_SUBJECT_ACCESS 정보주체 열람(§35)
SET LOCAL lock_timeout = '2s';

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
        ('retained_record_purpose', 'OTHER', true, 8)
$$;
-- END GENERATED

-- The stored shape of any reason code, system or tenant. Mirrors
-- code_lists::is_well_formed.
CREATE FUNCTION reason_code_well_formed(p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT p_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
$$;

CREATE FUNCTION reason_domain_known(p_domain TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT EXISTS (SELECT 1 FROM system_reason_codes() s WHERE s.domain = p_domain)
$$;

-- ---------------------------------------------------------------------------
-- 1. Tenant-added codes.
-- ---------------------------------------------------------------------------
CREATE TABLE reason_codes (
    -- RESTRICT, not CASCADE: platform_force_remove_direct_org_children sweeps
    -- only RESTRICT/NO ACTION org children, and must clear these rows before
    -- users go (created_by is RESTRICT).
    org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    domain        TEXT        NOT NULL CHECK (reason_domain_known(domain)),
    code          TEXT        NOT NULL CHECK (code ~ '^T_[0-9A-F]{32}$'),
    label_ko      TEXT        NOT NULL
        CHECK (btrim(label_ko) <> '' AND char_length(label_ko) <= 60),
    label_en      TEXT        NULL
        CHECK (label_en IS NULL OR (btrim(label_en) <> '' AND char_length(label_en) <= 60)),
    requires_note BOOLEAN     NOT NULL,
    active        BOOLEAN     NOT NULL DEFAULT true,
    sort          INT         NOT NULL DEFAULT 0,
    created_by    UUID        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, domain, code),
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
-- Two chips with the same label in one domain would be indistinguishable.
CREATE UNIQUE INDEX reason_codes_label_idx
    ON reason_codes (org_id, domain, lower(btrim(label_ko)));

ALTER TABLE reason_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE reason_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON reason_codes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT ON reason_codes TO console_rt;
GRANT UPDATE (active, sort) ON reason_codes TO console_rt;

COMMENT ON COLUMN reason_codes.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN reason_codes.domain IS 'pd:none — reason domain (code_lists::ReasonDomain)';
COMMENT ON COLUMN reason_codes.code IS 'pd:none — tenant reason code, T_ namespace';
COMMENT ON COLUMN reason_codes.label_ko IS 'pd:none — admin-authored catalog label (Korean)';
COMMENT ON COLUMN reason_codes.label_en IS 'pd:none — admin-authored catalog label (English)';
COMMENT ON COLUMN reason_codes.requires_note IS 'pd:none — a note must accompany the code';
COMMENT ON COLUMN reason_codes.active IS 'pd:none — offered for new records';
COMMENT ON COLUMN reason_codes.sort IS 'pd:none — display order among tenant codes';
COMMENT ON COLUMN reason_codes.created_by IS 'pd:personal — admin who added the code';
COMMENT ON COLUMN reason_codes.created_at IS 'pd:none — when the code was added';

-- ---------------------------------------------------------------------------
-- 2. Org change: events (all transitions) and approval steps (decisions).
-- ---------------------------------------------------------------------------
ALTER TABLE org_change_events
    ADD COLUMN reason_code TEXT NULL
        CHECK (reason_code IS NULL OR reason_code_well_formed(reason_code));
ALTER TABLE org_change_approval_steps
    ADD COLUMN reason_code TEXT NULL
        CHECK (reason_code IS NULL OR reason_code_well_formed(reason_code));

COMMENT ON COLUMN org_change_events.reason_code IS 'pd:none — BW-07 reason code of the transition; the note is reason';
COMMENT ON COLUMN org_change_approval_steps.reason_code IS 'pd:none — BW-07 reason code of the decision; the note is memo';

-- ---------------------------------------------------------------------------
-- 3. Lifecycle events: the record reason and the cancel reason. comment
--    becomes an optional note, capped at 1000 characters (X6). NOT VALID:
--    older rows may be longer; new and updated rows are checked.
-- ---------------------------------------------------------------------------
ALTER TABLE employee_lifecycle_events
    ADD COLUMN reason_code TEXT NULL
        CHECK (reason_code IS NULL OR reason_code_well_formed(reason_code)),
    ADD COLUMN cancel_reason_code TEXT NULL
        CHECK (cancel_reason_code IS NULL OR reason_code_well_formed(cancel_reason_code)),
    ALTER COLUMN comment DROP NOT NULL;
ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT employee_lifecycle_events_comment_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_comment_check
    CHECK (comment IS NULL OR btrim(comment) <> '');
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_reason_present
    CHECK (reason_code IS NOT NULL OR comment IS NOT NULL);
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_comment_max
    CHECK (comment IS NULL OR char_length(comment) <= 1000) NOT VALID;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_cancel_reason_code_state
    CHECK (cancel_reason_code IS NULL OR state = 'CANCELLED');

-- A SCHEDULED row's cancellation records its code (the 0246 trigger allows
-- updates of SCHEDULED rows; this grant is the column list).
GRANT UPDATE (cancel_reason_code) ON employee_lifecycle_events TO console_rt;

COMMENT ON COLUMN employee_lifecycle_events.reason_code IS 'pd:none — BW-07 reason code of the event; the note is comment';
COMMENT ON COLUMN employee_lifecycle_events.cancel_reason_code IS 'pd:none — BW-07 reason code of the cancellation; the note is cancel_reason';

-- ---------------------------------------------------------------------------
-- 4. Exit cases: the reject/cancel reason.
-- ---------------------------------------------------------------------------
ALTER TABLE employee_exit_cases
    ADD COLUMN closed_reason_code TEXT NULL
        CHECK (closed_reason_code IS NULL OR reason_code_well_formed(closed_reason_code));
ALTER TABLE employee_exit_cases ADD CONSTRAINT employee_exit_cases_closed_reason_code_closed
    CHECK (closed_reason_code IS NULL OR closed_at IS NOT NULL);

COMMENT ON COLUMN employee_exit_cases.closed_reason_code IS 'pd:none — BW-07 reason code of the rejection/cancellation; the note is closed_reason';

-- ---------------------------------------------------------------------------
-- 5. Period locks: lock and unlock reasons. reason becomes an optional note.
-- ---------------------------------------------------------------------------
ALTER TABLE period_locks
    ADD COLUMN reason_code TEXT NULL
        CHECK (reason_code IS NULL OR reason_code_well_formed(reason_code)),
    ADD COLUMN unlock_reason_code TEXT NULL
        CHECK (unlock_reason_code IS NULL OR reason_code_well_formed(unlock_reason_code)),
    ALTER COLUMN reason DROP NOT NULL;
ALTER TABLE period_locks DROP CONSTRAINT period_locks_reason_check;
ALTER TABLE period_locks ADD CONSTRAINT period_locks_reason_check
    CHECK (reason IS NULL OR btrim(reason) <> '');
ALTER TABLE period_locks ADD CONSTRAINT period_locks_reason_present
    CHECK (reason_code IS NOT NULL OR reason IS NOT NULL);
ALTER TABLE period_locks DROP CONSTRAINT period_locks_unlock_pair;
ALTER TABLE period_locks ADD CONSTRAINT period_locks_unlock_pair CHECK (
    (unlocked_at IS NULL AND unlock_reason IS NULL AND unlock_reason_code IS NULL)
    OR (unlocked_at IS NOT NULL
        AND (unlock_reason IS NULL OR btrim(unlock_reason) <> '')
        AND (unlock_reason IS NOT NULL OR unlock_reason_code IS NOT NULL))
);

-- 0107's function plus one line: the lock's reason_code is frozen like reason.
CREATE OR REPLACE FUNCTION period_locks_unlock_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.unlocked_at IS NOT NULL THEN
        RAISE EXCEPTION 'period lock % is already unlocked and immutable', OLD.id
            USING ERRCODE = '25006';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.domain IS DISTINCT FROM OLD.domain
        OR NEW.period_start IS DISTINCT FROM OLD.period_start
        OR NEW.period_end IS DISTINCT FROM OLD.period_end
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
        OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
        OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
        OR NEW.unlocked_at IS NULL
    THEN
        RAISE EXCEPTION 'period lock rows only permit the one-shot unlock update'
            USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON COLUMN period_locks.reason_code IS 'pd:none — BW-07 reason code of the lock; the note is reason';
COMMENT ON COLUMN period_locks.unlock_reason_code IS 'pd:none — BW-07 reason code of the unlock; the note is unlock_reason';

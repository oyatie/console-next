-- 인사카드 company sections (MR-33: 어학, 포상, 징계, 가족) and the restricted
-- 장애·보훈 sections (MR-35) on the 0261 shape: same anchor table, same
-- append-only revisions, one typed column group per section.
--
-- Lane number (head+1 of hard/emp-record/mr31 = 0261); INTEG renumbers.
-- Writer crate: console-hr-adapter-postgres (module `record`).
--
-- SECTIONS. 상벌 is two sections, AWARD (포상) and DISCIPLINE (징계), because
-- they are read differently: 징계 is restricted (below). Both use the rnd_*
-- columns; only DISCIPLINE has an end date (정직·감급 기간).
--
-- PII MINIMISATION (개인정보 보호법 §16①):
--   * 가족 keeps relation, name, birth date and 동거 only. No 주민등록번호 of a
--     family member (§24조의2; person_record_text_ok refuses the shape) and no
--     부양 flag: 연말정산 부양가족 belongs to payroll (deferred).
--   * 장애 keeps the severity only (중증 / 경증), which is what 의무고용 counting
--     reads: 장애인고용촉진법 §2제2호 (중증장애인), §28의3 (중증 = 2인 산정).
--     No 장애 유형 and no 장애 정도 detail.
--   * 보훈 keeps whether the employee is the 국가유공자 or a family member
--     (취업지원 대상자, 국가유공자법 §29) only. No 상이 등급 (health).
--
-- RESTRICTED (MR-35). 장애 is 건강 information, 민감정보 under PIPA §23①
-- (시행 2026-09-11, 법률 제21445호). Processing it needs either a separate
-- consent (§23①1) or a statute that requires or permits it (§23①2), and the
-- §29 safety measures (§23②). So every DISABILITY / VETERAN revision carries
-- its basis: CONSENT with the consent date, or STATUTE with a code naming the
-- statute, and the CHECKs below refuse a restricted row without one:
--   DISABLED_EMPLOYMENT  장애인고용촉진법 §28① (의무고용, 상시 50명 이상),
--                        §29① (고용계획·실시상황 기록 제출), §33①⑤ (부담금
--                        신고, 상시 100명 이상) — 시행 2025-11-11.
--   VETERAN_EMPLOYMENT   국가유공자법 §30제2호 (하루 20명 이상 고용 기업체가
--                        취업지원 실시기관), §33의2① (우선고용 의무 3~8%),
--                        §34 (보훈특별고용) — 시행 2026-09-08.
-- [J] Whether these duties are a §23①2 basis for a given employer (headcount
-- thresholds, the §30제2호 manufacturing carve-out) is a legal reading for
-- counsel, not a fact this schema decides. [J] 보훈 status is not listed in
-- §23① or 시행령 §18; it is treated as restricted because it can reveal 상이.
-- Both sections' tenant switches default OFF (hr.record.{disability,veteran}
-- .enabled): §23① is a prohibition with exceptions, and switching one on is a
-- loosening (the 24 h delay path). Reads of 징계·장애·보훈 are purpose-coded
-- (reason domain restricted_record_purpose) and audited by the reader.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Section lists.
ALTER TABLE person_record_entries DROP CONSTRAINT person_record_entries_section_check;
ALTER TABLE person_record_entries ADD CONSTRAINT person_record_entries_section_check
    CHECK (section IN ('EDUCATION', 'QUALIFICATION', 'MILITARY', 'TRAINING',
                       'LANGUAGE', 'AWARD', 'DISCIPLINE', 'FAMILY', 'DISABILITY', 'VETERAN'));
ALTER TABLE person_record_import_batches DROP CONSTRAINT person_record_import_batches_section_check;
ALTER TABLE person_record_import_batches ADD CONSTRAINT person_record_import_batches_section_check
    CHECK (section IN ('EDUCATION', 'QUALIFICATION', 'MILITARY', 'TRAINING',
                       'LANGUAGE', 'AWARD', 'DISCIPLINE', 'FAMILY', 'DISABILITY', 'VETERAN'));

-- ---------------------------------------------------------------------------
-- Value columns. 0261's per-section CHECKs already keep its own groups NULL
-- for these sections; the CHECKs below keep these groups NULL for the rest.
ALTER TABLE person_record_revisions
    -- 어학
    ADD COLUMN lang_language    TEXT    NULL CHECK (lang_language ~ '^[a-z]{2,3}$'),
    ADD COLUMN lang_test        TEXT    NULL CHECK (char_length(lang_test) BETWEEN 1 AND 100 AND person_record_text_ok(lang_test)),
    ADD COLUMN lang_score       TEXT    NULL CHECK (char_length(lang_score) BETWEEN 1 AND 30 AND person_record_text_ok(lang_score)),
    ADD COLUMN lang_taken_on    DATE    NULL,
    ADD COLUMN lang_expires_on  DATE    NULL,
    -- 포상 / 징계
    ADD COLUMN rnd_title        TEXT    NULL CHECK (char_length(rnd_title) BETWEEN 1 AND 100 AND person_record_text_ok(rnd_title)),
    ADD COLUMN rnd_decided_on   DATE    NULL,
    ADD COLUMN rnd_issuer       TEXT    NULL CHECK (char_length(rnd_issuer) BETWEEN 1 AND 100 AND person_record_text_ok(rnd_issuer)),
    ADD COLUMN rnd_details      TEXT    NULL CHECK (char_length(rnd_details) BETWEEN 1 AND 500 AND person_record_text_ok(rnd_details)),
    ADD COLUMN rnd_ends_on      DATE    NULL,
    -- 가족
    ADD COLUMN fam_relation     TEXT    NULL CHECK (fam_relation IN ('SPOUSE', 'CHILD', 'PARENT', 'PARENT_IN_LAW', 'SIBLING', 'GRANDPARENT', 'GRANDCHILD', 'OTHER')),
    ADD COLUMN fam_name         TEXT    NULL CHECK (char_length(fam_name) BETWEEN 1 AND 50 AND person_record_text_ok(fam_name)),
    ADD COLUMN fam_birth_date   DATE    NULL,
    ADD COLUMN fam_cohabiting   BOOLEAN NULL,
    -- 장애
    ADD COLUMN dis_severity     TEXT    NULL CHECK (dis_severity IN ('SEVERE', 'NON_SEVERE')),
    ADD COLUMN dis_recognised_on DATE   NULL,
    -- 보훈
    ADD COLUMN vet_target       TEXT    NULL CHECK (vet_target IN ('SELF', 'FAMILY')),
    ADD COLUMN vet_recognised_on DATE   NULL,
    -- §23① basis of a restricted revision
    ADD COLUMN basis            TEXT    NULL CHECK (basis IN ('CONSENT', 'STATUTE')),
    ADD COLUMN basis_consent_on DATE    NULL,
    ADD COLUMN basis_statute    TEXT    NULL CHECK (basis_statute IN ('DISABLED_EMPLOYMENT', 'VETERAN_EMPLOYMENT')),
    ADD CONSTRAINT person_record_revisions_language CHECK (
        (section = 'LANGUAGE') = (lang_language IS NOT NULL)
        AND (section = 'LANGUAGE' OR (lang_test IS NULL AND lang_score IS NULL
                                      AND lang_taken_on IS NULL AND lang_expires_on IS NULL))
        AND (lang_expires_on IS NULL OR lang_taken_on IS NULL OR lang_expires_on >= lang_taken_on)),
    ADD CONSTRAINT person_record_revisions_award_discipline CHECK (
        (section IN ('AWARD', 'DISCIPLINE')) = (rnd_title IS NOT NULL AND rnd_decided_on IS NOT NULL)
        AND (section IN ('AWARD', 'DISCIPLINE') OR (rnd_issuer IS NULL AND rnd_details IS NULL))
        AND (section = 'DISCIPLINE' OR rnd_ends_on IS NULL)
        AND (rnd_ends_on IS NULL OR rnd_ends_on >= rnd_decided_on)),
    ADD CONSTRAINT person_record_revisions_family CHECK (
        (section = 'FAMILY') = (fam_relation IS NOT NULL AND fam_name IS NOT NULL)
        AND (section = 'FAMILY' OR (fam_birth_date IS NULL AND fam_cohabiting IS NULL))),
    ADD CONSTRAINT person_record_revisions_disability CHECK (
        (section = 'DISABILITY') = (dis_severity IS NOT NULL)
        AND (section = 'DISABILITY' OR dis_recognised_on IS NULL)),
    ADD CONSTRAINT person_record_revisions_veteran CHECK (
        (section = 'VETERAN') = (vet_target IS NOT NULL)
        AND (section = 'VETERAN' OR vet_recognised_on IS NULL)),
    ADD CONSTRAINT person_record_revisions_basis CHECK (
        (section IN ('DISABILITY', 'VETERAN')) = (basis IS NOT NULL)
        AND (basis IS NOT NULL OR (basis_consent_on IS NULL AND basis_statute IS NULL))
        AND (basis IS DISTINCT FROM 'CONSENT' OR (basis_consent_on IS NOT NULL AND basis_statute IS NULL))
        AND (basis IS DISTINCT FROM 'STATUTE' OR (basis_statute IS NOT NULL AND basis_consent_on IS NULL))
        AND (basis_statute IS NULL
             OR (section = 'DISABILITY' AND basis_statute = 'DISABLED_EMPLOYMENT')
             OR (section = 'VETERAN' AND basis_statute = 'VETERAN_EMPLOYMENT')));

-- ---------------------------------------------------------------------------
-- Classification (the section columns keep their 0261 markers).
COMMENT ON COLUMN person_record_revisions.lang_language IS 'pd:personal — 어학: language (ISO 639 code)';
COMMENT ON COLUMN person_record_revisions.lang_test IS 'pd:personal — 어학: test name';
COMMENT ON COLUMN person_record_revisions.lang_score IS 'pd:personal — 어학: score or grade';
COMMENT ON COLUMN person_record_revisions.lang_taken_on IS 'pd:personal — 어학: taken on';
COMMENT ON COLUMN person_record_revisions.lang_expires_on IS 'pd:personal — 어학: valid until';
COMMENT ON COLUMN person_record_revisions.rnd_title IS 'pd:personal — 포상/징계: title (포상명 or 징계 종류)';
COMMENT ON COLUMN person_record_revisions.rnd_decided_on IS 'pd:personal — 포상/징계: decided on';
COMMENT ON COLUMN person_record_revisions.rnd_issuer IS 'pd:personal — 포상/징계: issuing body';
COMMENT ON COLUMN person_record_revisions.rnd_details IS 'pd:personal — 포상/징계: details';
COMMENT ON COLUMN person_record_revisions.rnd_ends_on IS 'pd:personal — 징계: end of the disciplinary period';
COMMENT ON COLUMN person_record_revisions.fam_relation IS 'pd:personal — 가족: relation to the employee';
COMMENT ON COLUMN person_record_revisions.fam_name IS 'pd:personal — 가족: family member name (a third party)';
COMMENT ON COLUMN person_record_revisions.fam_birth_date IS 'pd:personal — 가족: family member birth date';
COMMENT ON COLUMN person_record_revisions.fam_cohabiting IS 'pd:personal — 가족: lives with the employee';
COMMENT ON COLUMN person_record_revisions.dis_severity IS 'pd:sensitive/health — 장애: 중증 or 경증 (PIPA §23)';
COMMENT ON COLUMN person_record_revisions.dis_recognised_on IS 'pd:sensitive/health — 장애: recognised on';
COMMENT ON COLUMN person_record_revisions.vet_target IS 'pd:sensitive/health — 보훈: 국가유공자 or family member (restricted, [J] may reveal 상이)';
COMMENT ON COLUMN person_record_revisions.vet_recognised_on IS 'pd:sensitive/health — 보훈: recognised on';
COMMENT ON COLUMN person_record_revisions.basis IS 'pd:none — PIPA §23① basis of a restricted revision: CONSENT | STATUTE';
COMMENT ON COLUMN person_record_revisions.basis_consent_on IS 'pd:personal — date of the subject''s separate consent (§23①1)';
COMMENT ON COLUMN person_record_revisions.basis_statute IS 'pd:none — statute relied on (§23①2): DISABLED_EMPLOYMENT | VETERAN_EMPLOYMENT';

-- ---------------------------------------------------------------------------
-- The six new section switches (hr.record.<section>.enabled). Regenerated
-- whole from the key roster (crates/settings/domain/tests/sql_definitions.rs
-- now pins this file). INTEG: if another lane added keys first, regenerate
-- this block once more at the merge.
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
        ('hr.record.veteran.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

-- ---------------------------------------------------------------------------
-- The restricted_record_purpose reason domain (crates/settings/domain
-- code_lists/roster.rs). system_reason_codes() is regenerated whole
-- (code_lists/tests.rs now pins this file); reason_domain_known() calls it by
-- name, so the drop is safe. INTEG: regenerate once more if another lane
-- added a domain first.
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
        ('restricted_record_purpose', 'OTHER', true, 7)
$$;
-- END GENERATED

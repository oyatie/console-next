-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; released migrations are immutable. P0-EXIT-GUARDS.
SET LOCAL lock_timeout = '2s';
ALTER TABLE reason_codes
    ADD COLUMN involuntary BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN notice_required BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT reason_codes_notice_class CHECK (NOT notice_required OR involuntary) NOT VALID,
    ADD CONSTRAINT reason_codes_exit_class CHECK (domain = 'exit_reason' OR NOT involuntary) NOT VALID;
ALTER TABLE reason_codes VALIDATE CONSTRAINT reason_codes_notice_class;
ALTER TABLE reason_codes VALIDATE CONSTRAINT reason_codes_exit_class;
COMMENT ON COLUMN reason_codes.involuntary IS 'pd:none — dismissal-like protected-period class; not employment-insurance classification';
COMMENT ON COLUMN reason_codes.notice_required IS 'pd:none — written dismissal notice required; implies involuntary';

ALTER TABLE employee_exit_cases
    ADD COLUMN dismissal_notice_reason TEXT,
    ADD COLUMN dismissal_notice_served_on DATE,
    ADD COLUMN dismissal_notice_method TEXT,
    ADD COLUMN dismissal_notice_evidence_ref TEXT,
    ADD CONSTRAINT employee_exit_cases_notice_method CHECK (dismissal_notice_method IN ('IN_PERSON_SIGNED','CERTIFIED_MAIL','ELECTRONIC')) NOT VALID,
    ADD CONSTRAINT employee_exit_cases_notice_complete CHECK (
        (dismissal_notice_reason IS NULL AND dismissal_notice_served_on IS NULL AND dismissal_notice_method IS NULL AND dismissal_notice_evidence_ref IS NULL)
        OR (dismissal_notice_reason IS NOT NULL AND btrim(dismissal_notice_reason) <> ''
            AND dismissal_notice_served_on IS NOT NULL AND dismissal_notice_served_on <= effective_exit_date + 1
            AND dismissal_notice_method IS NOT NULL AND dismissal_notice_evidence_ref IS NOT NULL AND btrim(dismissal_notice_evidence_ref) <> '')
    ) NOT VALID;
ALTER TABLE employee_exit_cases VALIDATE CONSTRAINT employee_exit_cases_notice_method;
ALTER TABLE employee_exit_cases VALIDATE CONSTRAINT employee_exit_cases_notice_complete;
COMMENT ON COLUMN employee_exit_cases.dismissal_notice_reason IS 'pd:personal — written dismissal grounds under 근로기준법 제27조';
COMMENT ON COLUMN employee_exit_cases.dismissal_notice_served_on IS 'pd:personal — written notice delivery date';
COMMENT ON COLUMN employee_exit_cases.dismissal_notice_method IS 'pd:personal — written notice delivery method';
COMMENT ON COLUMN employee_exit_cases.dismissal_notice_evidence_ref IS 'pd:personal — receipt, registered mail or electronic delivery record reference';

ALTER TABLE employee_lifecycle_events DROP CONSTRAINT employee_lifecycle_events_leave_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_leave_type_check
    CHECK (leave_type IS NULL OR leave_type IN ('CHILDCARE','MATERNITY','WORK_INJURY','ILLNESS','PERSONAL','OTHER')) NOT VALID;
ALTER TABLE employee_lifecycle_events VALIDATE CONSTRAINT employee_lifecycle_events_leave_type_check;
COMMENT ON COLUMN employee_lifecycle_events.leave_type IS 'pd:personal,sensitive/health — leave-of-absence type; ILLNESS, MATERNITY and WORK_INJURY reveal health (개보법 제23조)';

ALTER TABLE statutory_rules DROP CONSTRAINT statutory_rules_code_check;
ALTER TABLE statutory_rules ADD CONSTRAINT statutory_rules_code_check CHECK (code IN (
'FINAL_PAY_DUE_DAYS',
'LATE_WAGE_INTEREST_ANNUAL_RATE',
'DISMISSAL_NOTICE_DAYS',
'AVERAGE_WAGE_WINDOW_MONTHS',
'EMPLOYMENT_RECORD_RETENTION_YEARS',
'EMPLOYMENT_CERTIFICATE_REQUEST_YEARS',
'EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS',
'SEVERANCE_PAY_DUE_DAYS',
'SEVERANCE_MIN_SERVICE_YEARS',
'SEVERANCE_MIN_WEEKLY_HOURS',
'EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH',
'NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH',
'NHIS_LOSS_REPORT_DUE_DAYS',
'SEPARATION_CERTIFICATE_DUE_DAYS',
'FIXED_TERM_MAX_YEARS',
'MANAGERIAL_DISMISSAL_CONSULT_DAYS',
'UNFAIR_DISMISSAL_CLAIM_MONTHS',
'ins.deadline.acquire.nps',
'ins.deadline.acquire.nhis',
'ins.deadline.acquire.ei',
'ins.deadline.acquire.iaci',
'ins.deadline.lose.iaci',
'ins.deadline.leave.ei',
'ins.deadline.leave.iaci',
'ins.filing.work_confirmation.ei',
'ins.filing.work_confirmation.iaci',
'ins.filing.age60.nps',
'ins.filing.acquire_requested.ei',
'ins.filing.monthly_remuneration.ei',
'ins.filing.monthly_remuneration.iaci',
'ins.deadline.leave.nps',
'ins.deadline.leave.nhis',
'ins.deadline.resume.nps',
'ins.deadline.resume.nhis',
'ins.deadline.resume.ei',
'ins.deadline.resume.iaci',
'DISMISSAL_PROTECTION_TAIL_DAYS',
'CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS')) NOT VALID;
ALTER TABLE statutory_rules VALIDATE CONSTRAINT statutory_rules_code_check;

INSERT INTO statutory_rules (
    code, effective_from, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
) VALUES
    ('DISMISSAL_PROTECTION_TAIL_DAYS', DATE '2026-10-08', 'DAYS', 30, 1,
     '근로기준법',
     '제23조제2항 「사용자는 근로자가 업무상 부상 또는 질병의 요양을 위하여 휴업한 기간과 그 후 30일 동안 또는 산전(産前)ㆍ산후(産後)의 여성이 이 법에 따라 휴업한 기간과 그 후 30일 동안은 해고하지 못한다. 다만, 사용자가 제84조에 따라 일시보상을 하였을 경우 또는 사업을 계속할 수 없게 된 경우에는 그러하지 아니하다.」',
     '법률 제21533호', DATE '2026-10-08', 'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-21',
     'law.go.kr DRF lawService MST 285279, 2026-10-21 조회. 노무사 검토 전: 권고사직 보호기간 내 제한, 제74조제3항 유산·사산휴가 범위, 제27조 ELECTRONIC 수신 확인의 서면성(해석 16474), 보호기간 내 결정 후 기간 밖 시행의 적법성. 제84조 일시보상 및 사업 계속 불가의 통제된 예외는 미구현. 제27조제1항 해고사유와 해고시기의 서면 통지, 제2항 서면 통지의 효력 요건, 제3항 제26조 서면 예고의 통지 간주는 증빙 참조로 기록.'),
    ('CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS', DATE '2026-09-18', 'DAYS', 0, 1,
     '남녀고용평등법',
     '제19조제3항 「사업주는 육아휴직을 이유로 해고나 그 밖의 불리한 처우를 하여서는 아니 되며, 육아휴직 기간에는 그 근로자를 해고하지 못한다. 다만, 사업을 계속할 수 없는 경우에는 그러하지 아니하다.」',
     '법률 제21476호', DATE '2026-09-18', 'https://www.law.go.kr/법령/남녀고용평등과일ㆍ가정양립지원에관한법률', DATE '2026-10-21',
     'law.go.kr DRF lawService MST 284457, 2026-10-21 조회. 노무사 검토 전: 권고사직(진정한 합의) 보호기간 내 제한과 보호기간 내 결정 후 기간 밖 시행의 적법성. 사업 계속 불가의 통제된 예외는 미구현. 육아휴직 종료 후 보호 꼬리 없음.');

-- Use the same sourced instrument windows as 0253_statutory_register.sql.
-- The protection text and tail are unchanged across these instrument versions.
INSERT INTO statutory_rules (
    code, effective_from, effective_to_exclusive, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
)
SELECT r.code, s.effective_from, s.effective_to_exclusive, r.unit, r.value_num, r.value_den,
       r.instrument_ko, r.article_ko, s.promulgation_ko, s.effective_from,
       r.source_url, DATE '2026-10-21', s.provenance_ko || ' ' || r.provenance_ko
FROM statutory_rules r
CROSS JOIN (VALUES
    (DATE '2026-08-20', DATE '2026-10-02', '법률 제21373호',
     'law.go.kr DRF lawService MST 283457, 2026-10-21 조회. 0253 대장의 법령ID 001872 시행 2026-08-20 슬라이스. 제23조제2항 보호기간은 후속 슬라이스와 동일.'),
    (DATE '2026-10-02', DATE '2026-10-08', '법률 제21857호',
     'law.go.kr DRF lawService MST 290781, 2026-10-21 재조회. 제23조제2항과 제27조제1항·제2항·제3항은 MST 285279와 동일.')
) AS s(effective_from, effective_to_exclusive, promulgation_ko, provenance_ko)
WHERE r.code = 'DISMISSAL_PROTECTION_TAIL_DAYS' AND r.effective_from = DATE '2026-10-08';


-- §19③ is identical in the August and September childcare instruments.
INSERT INTO statutory_rules (
    code, effective_from, effective_to_exclusive, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
)
SELECT r.code, DATE '2026-08-20', DATE '2026-09-18', r.unit, r.value_num, r.value_den,
       r.instrument_ko, r.article_ko, '법률 제21373호', DATE '2026-08-20',
       r.source_url, DATE '2026-10-21',
       'law.go.kr DRF lawService MST 283455, 2026-10-21 조회. 제19조제3항은 MST 284457과 동일. ' || r.provenance_ko
FROM statutory_rules r
WHERE r.code = 'CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS' AND r.effective_from = DATE '2026-09-18';

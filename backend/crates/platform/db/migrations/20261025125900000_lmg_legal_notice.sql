-- SPDX-License-Identifier: LicenseRef-Proprietary
-- LMG-LEGAL: additive facts; N-1 clients may omit the disposition.
SET LOCAL lock_timeout = '2s';
ALTER TABLE employee_exit_cases ADD COLUMN notice_disposition JSONB;
COMMENT ON COLUMN employee_exit_cases.notice_disposition IS 'pd:personal — explicit notice-pay disposition, statutory ground and evidence reference';
ALTER TABLE employee_exit_cases ADD CONSTRAINT employee_exit_notice_disposition_check CHECK (
    notice_disposition IS NULL OR COALESCE((
      jsonb_typeof(notice_disposition) = 'object' AND
      (notice_disposition->>'kind' = 'PAY_IN_LIEU' OR
       (notice_disposition->>'kind' = 'REGISTER_EXCEPTION' AND
        length(btrim(notice_disposition->>'ground_code')) > 0 AND
        length(btrim(notice_disposition->>'evidence_ref')) > 0))
    ),false)
) NOT VALID;
ALTER TABLE employee_exit_cases VALIDATE CONSTRAINT employee_exit_notice_disposition_check;
ALTER TABLE statutory_rules ADD COLUMN notice_exception_grounds JSONB;
COMMENT ON COLUMN statutory_rules.notice_exception_grounds IS 'pd:none — cited dismissal-notice proviso grounds; HOLD pending qualified review';
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
'DISMISSAL_NOTICE_MIN_SERVICE_MONTHS',
'DISMISSAL_PROTECTION_TAIL_DAYS',
'CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS')) NOT VALID;
ALTER TABLE statutory_rules VALIDATE CONSTRAINT statutory_rules_code_check;

INSERT INTO statutory_rules (code,effective_from,effective_to_exclusive,unit,value_num,value_den,
    instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,provenance_ko,
    notice_exception_grounds)
SELECT 'DISMISSAL_NOTICE_MIN_SERVICE_MONTHS',effective_from,effective_to_exclusive,'MONTHS',3,1,
    instrument_ko,
    '제26조 단서 「다만, 다음 각 호의 어느 하나에 해당하는 경우에는 그러하지 아니하다. 1. 근로자가 계속 근로한 기간이 3개월 미만인 경우 2. 천재ㆍ사변, 그 밖의 부득이한 사유로 사업을 계속하는 것이 불가능한 경우 3. 근로자가 고의로 사업에 막대한 지장을 초래하거나 재산상 손해를 끼친 경우로서 고용노동부령으로 정하는 사유에 해당하는 경우」',
    promulgation_ko,enforced_on,source_url,retrieved_on,
    'UNVERIFIED · 노무사 검토 전. 0253 제26조 대장의 단서 연결. 기본: 예고 부족은 거절, 수당 지급 또는 대장 단서와 증빙을 명시하면 진행. 단서의 증빙 적합성과 계속근로 계산은 검토 대상.',
    '[{"code":"UNAVOIDABLE_CLOSURE","label_ko":"천재ㆍ사변 등으로 사업 계속 불가"},{"code":"INTENTIONAL_DAMAGE","label_ko":"고용노동부령상 고의의 중대한 지장·재산상 손해"}]'::jsonb
FROM statutory_rules WHERE code='DISMISSAL_NOTICE_DAYS';

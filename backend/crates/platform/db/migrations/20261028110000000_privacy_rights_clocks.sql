-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand-only rights clocks; HOLD pending qualified review. No request retention period is asserted.
SET LOCAL lock_timeout = '2s';
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
'CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS',
'WEEKLY_STANDARD_HOURS',
'WEEKLY_OVERTIME_MAX_HOURS',
'PIPA_ACCESS_RESPONSE_DAYS',
'PIPA_CORRECTION_RESPONSE_DAYS',
'PIPA_SUSPENSION_RESPONSE_DAYS')) NOT VALID;
ALTER TABLE statutory_rules VALIDATE CONSTRAINT statutory_rules_code_check;

INSERT INTO statutory_rules (code,effective_from,unit,value_num,value_den,
    instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,provenance_ko)
SELECT code,DATE '2026-09-11','DAYS',10,1,'개인정보 보호법 시행령',article,
    '대통령령 제36671호',DATE '2026-09-11',
    'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=289537&efYd=20260911',DATE '2026-10-27',
    '법무 검토 전 HOLD. 받은 날은 산입하지 않습니다(민법 제157조). 제161조의 휴일 이월 적용은 미확인으로 이월하지 않습니다. 동의 철회는 법 제37조제3항의 지체 없이이며 숫자 기한을 두지 않습니다.'
FROM (VALUES
    ('PIPA_ACCESS_RESPONSE_DAYS','제41조제4항·제5항'),
    ('PIPA_CORRECTION_RESPONSE_DAYS','제43조제3항'),
    ('PIPA_SUSPENSION_RESPONSE_DAYS','제44조제2항')
) v(code,article);

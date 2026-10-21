-- BW-12: the fixed-term service limit (기간제법 §4①) as a statutory register
-- row, so the renewal check reads the number from the register (OD-9), never a
-- constant. Numbered head+1 of hard/life/bw12 (0257); INTEG renumbers at the
-- batch merge. Ships HOLD like every 0253 row (CTRL-KR-WORKFORCE-001).
--
-- The code list grows by one; console_compliance_domain::statutory::codes::ALL
-- grows in the same branch (StatutoryRegister::new fails closed on a code it
-- does not know).
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
    'FIXED_TERM_MAX_YEARS'));

INSERT INTO statutory_rules (
    code, effective_from, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
) VALUES
    ('FIXED_TERM_MAX_YEARS', DATE '2021-05-18', 'YEARS', 2, 1,
     '기간제 및 단시간근로자 보호 등에 관한 법률',
     '제4조제1항 「사용자는 2년을 초과하지 아니하는 범위 안에서(기간제 근로계약의 반복갱신 등의 경우에는 그 계속근로한 총기간이 2년을 초과하지 아니하는 범위 안에서) 기간제근로자를 사용할 수 있다」 — 단서 각 호는 FIXED_TERM_OVER_TWO_YEARS 예외(BW-06)',
     '법률 제18177호', DATE '2021-05-18',
     'https://www.law.go.kr/법령/기간제및단시간근로자보호등에관한법률', DATE '2026-10-04',
     '법령ID 010356, 공포·시행 2021-05-18(일부개정) 현행 슬라이스(law.go.kr DRF lawService, 2026-10-04)에서 제4조제1항을 읽음(조문 개정 2020.5.26 표기). 기간 계산은 민법 제160조. 갱신 사이 공백의 계속근로 판단과 육아휴직 기간 제외(남녀고용평등법 제19조제5항)의 적용은 미확인(노무사 #9).');

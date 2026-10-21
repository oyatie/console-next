-- BW-30: the statutory register — legal numbers, clocks and 4대보험 상실 codes.
-- Numbered head+1 of console-react-mvp 7ae5421; INTEG renumbers at the batch merge.
-- Rows follow ST-1 (docs/legal/statute-verify.md, law.go.kr DRF, 2026-10-02).
--
-- Reference data, not seed data (OD-9). Every row is a cited legal fact and
-- ships HOLD: CTRL-KR-WORKFORCE-001 in docs/program/console-jurisdiction-register.json
-- stays HOLD until a qualified 노무사 lifts it (decisions.md #9, Appendix B 1–2).
-- A HOLD row is still served (the exit clocks ship under HOLD with the earlier
-- date); the API shows the disposition next to the number.
--
-- Modelled on payroll_statutory_rates (0210): GLOBAL, no org_id, no RLS, and
-- SELECT-only to console_rt. A number changes by migration, which means by
-- deploy, which means by review. Never tenant-overridable (D0.3).
--
-- Overlapping periods for one key are rejected by
-- console_compliance_domain::statutory::StatutoryRegister::new at load time
-- (fail closed); btree_gist is not installed, so there is no EXCLUDE here.
--
-- The tenant-isolation global allowlist names both tables; the pd: column
-- comments below satisfy the personal-data-classification gate.
--
-- Coverage: each row starts on the 시행일자 of the slice whose text was read
-- (effective_from >= enforced_on, the 0210 lesson). A lookup for an earlier date
-- fails closed until the 노무사 adds rows citing the earlier slices. When a new
-- slice takes effect, the old row is closed (effective_to_exclusive) and a new
-- row cites the new slice, even when the article text is unchanged: the row
-- names the instrument actually in force.

-- ---------------------------------------------------------------------------
-- 1. statutory_rules: one legal number per (code, effective_from).
CREATE TABLE statutory_rules (
    code                   TEXT NOT NULL CHECK (code IN (
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
                               'SEPARATION_CERTIFICATE_DUE_DAYS')),
    effective_from         DATE NOT NULL,
    effective_to_exclusive DATE CHECK (effective_to_exclusive IS NULL OR effective_to_exclusive > effective_from),
    unit                   TEXT NOT NULL CHECK (unit IN (
                               'DAYS', 'MONTHS', 'YEARS', 'DAY_OF_NEXT_MONTH', 'HOURS_PER_WEEK', 'ANNUAL_RATE')),
    -- Exact num/den, never a decimal: 연 100분의 20 is 20/100.
    value_num              BIGINT NOT NULL CHECK (value_num >= 0),
    value_den              BIGINT NOT NULL DEFAULT 1 CHECK (value_den > 0),

    -- THE CITATION (same columns and rules as payroll_statutory_rates).
    instrument_ko          TEXT NOT NULL CHECK (btrim(instrument_ko) <> ''),
    article_ko             TEXT NOT NULL CHECK (btrim(article_ko) <> ''),
    promulgation_ko        TEXT NOT NULL CHECK (btrim(promulgation_ko) <> ''),
    enforced_on            DATE NOT NULL,
    source_url             TEXT NOT NULL CHECK (source_url LIKE 'https://www.law.go.kr/%'),
    retrieved_on           DATE NOT NULL,
    provenance_ko          TEXT NOT NULL CHECK (btrim(provenance_ko) <> ''),

    -- HOLD until a qualified reviewer records a receipt in the jurisdiction register.
    release_disposition    TEXT NOT NULL DEFAULT 'HOLD' CHECK (release_disposition IN ('HOLD', 'RELEASED')),
    review_receipt_ref     TEXT CHECK (review_receipt_ref IS NULL OR btrim(review_receipt_ref) <> ''),
    CONSTRAINT statutory_rules_receipt_iff_released
        CHECK ((release_disposition = 'RELEASED') = (review_receipt_ref IS NOT NULL)),
    CONSTRAINT statutory_rules_not_backdated_before_instrument
        CHECK (effective_from >= enforced_on),
    PRIMARY KEY (code, effective_from)
);

COMMENT ON TABLE statutory_rules IS
    '법정 기한·수치 인용 대장(BW-30). 전역·마이그레이션 전용·테넌트 변경 불가. 모든 행은 자격 있는 검토자가 해제하기 전까지 HOLD이며, 어떤 법적 결론도 주장하지 않는다.';

-- 근로기준법: 법률 제21373호 (시행 2026-08-20) was read first; 법률 제21857호
-- (타법개정, 시행 2026-10-02, MST 290781) superseded it. ST-1 diffed §2, §26,
-- §36, §42 across both slices: identical. The 21373 rows close on 2026-10-02.
INSERT INTO statutory_rules (
    code, effective_from, effective_to_exclusive, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
)
SELECT v.code, s.effective_from, s.effective_to_exclusive, v.unit, v.value_num, 1,
       '근로기준법', v.article_ko, s.promulgation_ko, s.effective_from,
       'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-02', s.provenance_ko || ' ' || v.note_ko
FROM (VALUES
    ('FINAL_PAY_DUE_DAYS', 'DAYS', 14,
     '제36조 「그 지급 사유가 발생한 때부터 14일 이내에 임금, 보상금, 그 밖의 모든 금품을 지급하여야 한다」',
     '기산일과 14일 계산 방식은 미확인(노무사 #9) — 확인 전까지 이른 날짜를 쓴다.'),
    ('DISMISSAL_NOTICE_DAYS', 'DAYS', 30,
     '제26조 「적어도 30일 전에 예고를 하여야 하고, 30일 전에 예고를 하지 아니하였을 때에는 30일분 이상의 통상임금을 지급하여야 한다」',
     '단서 각 호(계속근로 3개월 미만 등)의 적용 판단은 이 행이 하지 않는다.'),
    ('AVERAGE_WAGE_WINDOW_MONTHS', 'MONTHS', 3,
     '제2조제1항제6호 「이를 산정하여야 할 사유가 발생한 날 이전 3개월 동안에 그 근로자에게 지급된 임금의 총액」',
     '사유 발생일은 퇴직일(마지막 근무일 다음 날)이므로 마지막 근무일 9/30 → 7/1–9/30 구간(소비 측 고정 테스트). 제외 기간은 시행령 제2조제1항의 8개 유형.'),
    ('EMPLOYMENT_RECORD_RETENTION_YEARS', 'YEARS', 3,
     '제42조 「근로자 명부와 대통령령으로 정하는 근로계약에 관한 중요한 서류를 3년간 보존하여야 한다」 — 기산일은 시행령 제22조제2항',
     '서류별 기산일(시행령 제22조제2항 각 호)은 retention.* 설정 키의 하한으로 쓰인다.')
) AS v(code, unit, value_num, article_ko, note_ko)
CROSS JOIN (VALUES
    (DATE '2026-08-20', DATE '2026-10-02', '법률 제21373호',
     '법령ID 001872, 시행 2026-08-20 슬라이스에서 조문 전문을 읽음.'),
    (DATE '2026-10-02', NULL::date, '법률 제21857호',
     '법령ID 001872, MST 290781, 시행 2026-10-02 현행 슬라이스(law.go.kr DRF, ST-1)에서 조문 전문을 읽음.')
) AS s(effective_from, effective_to_exclusive, promulgation_ko, provenance_ko);

INSERT INTO statutory_rules (
    code, effective_from, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
) VALUES
    ('LATE_WAGE_INTEREST_ANNUAL_RATE', DATE '2025-10-23', 'ANNUAL_RATE', 20, 100,
     '근로기준법 시행령', '제17조 「법 제37조제1항 … "대통령령으로 정하는 이율"이란 연 100분의 20을 말한다」',
     '대통령령 제35436호', DATE '2025-10-23', 'https://www.law.go.kr/법령/근로기준법시행령', DATE '2026-10-02',
     '법령ID 003058, MST 270551, 시행 2025-10-23 현행 슬라이스에서 조문 전문을 읽음(ST-1). 기산은 법 제37조제1항제1호(지급 사유 발생일부터 14일이 되는 날)의 다음 날. 법 제37조제1항제2호(2024-10-22 개정)는 재직 중 미지급 임금(제43조제2항 지급일 기준)에도 적용된다. 합의 연장 중 이자 발생 여부는 미확인(노무사 #9).'),

    ('EMPLOYMENT_CERTIFICATE_REQUEST_YEARS', DATE '2025-10-23', 'YEARS', 3, 1,
     '근로기준법 시행령', '제19조 「청구할 수 있는 기한은 퇴직 후 3년 이내로 한다」 — 법 제39조제1항(즉시 발급)',
     '대통령령 제35436호', DATE '2025-10-23', 'https://www.law.go.kr/법령/근로기준법시행령', DATE '2026-10-02',
     '법령ID 003058, MST 270551, 시행 2025-10-23 현행 슬라이스에서 조문 전문을 읽음(ST-1). 같은 조의 근무 요건은 EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS 행.'),

    ('EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS', DATE '2025-10-23', 'DAYS', 30, 1,
     '근로기준법 시행령', '제19조 「사용증명서를 청구할 수 있는 자는 계속하여 30일 이상 근무한 근로자로 하되」 — 법 제39조제1항',
     '대통령령 제35436호', DATE '2025-10-23', 'https://www.law.go.kr/법령/근로기준법시행령', DATE '2026-10-02',
     '법령ID 003058, MST 270551, 시행 2025-10-23 현행 슬라이스에서 조문 전문을 읽음(ST-1 B9). 계속 근무 30일의 기산과 계산은 미확인(노무사 #9).'),

    ('SEVERANCE_PAY_DUE_DAYS', DATE '2026-07-01', 'DAYS', 14, 1,
     '근로자퇴직급여 보장법', '제9조제1항 「그 지급사유가 발생한 날부터 14일 이내에 퇴직금을 지급하여야 한다」 — 제2항 IRP 등 계정 이전(개정 2026.3.17)',
     '법률 제21475호', DATE '2026-07-01', 'https://www.law.go.kr/법령/근로자퇴직급여보장법', DATE '2026-10-02',
     '법령ID 009883, 시행 2026-07-01 슬라이스(부칙 제1조 본문)에서 조문 전문을 읽음. 2026-09-18 현행 슬라이스(MST 284455, 부칙 제1조 단서: 제43조·제44조만)와 제9조 동일(ST-1). 제9조제2항 단서의 예외는 시행령 제3조의2의 5개 사유(55세 이후 퇴직, 고시 금액 이하, 사망, 외국인 출국, 다른 법령에 따른 공제)로 확인됨(ST-1).'),

    ('SEVERANCE_MIN_SERVICE_YEARS', DATE '2026-07-01', 'YEARS', 1, 1,
     '근로자퇴직급여 보장법', '제4조제1항 단서 「계속근로기간이 1년 미만인 근로자 … 에 대하여는 그러하지 아니하다」',
     '법률 제21475호', DATE '2026-07-01', 'https://www.law.go.kr/법령/근로자퇴직급여보장법', DATE '2026-10-02',
     '법령ID 009883, 시행 2026-07-01 슬라이스에서 조문 전문을 읽음. 2026-09-18 현행 슬라이스와 제4조 동일(ST-1). 경계일(마지막 근무일+1 ≥ 입사일+1년) 판단은 미확인(노무사 #9).'),

    ('SEVERANCE_MIN_WEEKLY_HOURS', DATE '2026-07-01', 'HOURS_PER_WEEK', 15, 1,
     '근로자퇴직급여 보장법', '제4조제1항 단서 「4주간을 평균하여 1주간의 소정근로시간이 15시간 미만인 근로자에 대하여는 그러하지 아니하다」',
     '법률 제21475호', DATE '2026-07-01', 'https://www.law.go.kr/법령/근로자퇴직급여보장법', DATE '2026-10-02',
     '법령ID 009883, 시행 2026-07-01 슬라이스에서 조문 전문을 읽음. 2026-09-18 현행 슬라이스와 제4조 동일(ST-1).'),

    ('EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH', DATE '2026-09-18', 'DAY_OF_NEXT_MONTH', 15, 1,
     '고용보험법 시행령', '제7조제1항 「그 사유가 발생한 날이 속하는 달의 다음 달 15일까지(근로자가 그 기일 이전에 신고할 것을 요구하는 경우에는 지체 없이)」',
     '대통령령 제36588호', DATE '2026-09-18', 'https://www.law.go.kr/법령/고용보험법시행령', DATE '2026-10-02',
     '법령ID 002249, MST 288717, 시행 2026-09-18 현행 슬라이스에서 조문 전문을 읽음(ST-1). 「지체 없이」는 단서가 아니라 괄호. 「사유가 발생한 날」이 이직일인지 상실일(법 제14조제1항제3호: 이직한 날의 다음 날)인지 미확인(노무사 #9) — 확인 전까지 이른 날짜(마지막 근무일의 달)를 쓴다. 이 날짜 이전 슬라이스는 아직 인용하지 않았다.'),

    ('NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH', DATE '2026-02-13', 'DAY_OF_NEXT_MONTH', 15, 1,
     '국민연금법 시행규칙', '제6조제1항 「그 사유가 발생한 날이 속하는 달의 다음 달 15일까지 … 별지 제7호서식의 사업장가입자 자격상실신고서」',
     '보건복지부령 제1157호', DATE '2026-02-13', 'https://www.law.go.kr/법령/국민연금법시행규칙', DATE '2026-10-02',
     '법령ID 006709, MST 283561, 시행 2026-02-13 현행 슬라이스에서 조문 전문을 읽음(ST-1). 상실일은 사용관계가 끝난 날의 다음 날(법 제12조제1항제3호)이라 기산 사유일은 고용보험과 같은 미확인 사항(노무사 #9).'),

    ('NHIS_LOSS_REPORT_DUE_DAYS', DATE '2026-01-02', 'DAYS', 14, 1,
     '국민건강보험법', '제9조제1항제3호·제2항 「그 사용관계가 끝난 날의 다음 날」 자격 변동, 「자격이 변동된 날부터 14일 이내」; 제10조제2항 — 사용자 신고는 시행규칙 제4조제4항제2호(별지 제8호서식), 같은 조 제1항 단서로 세대주의 변동 신고를 갈음',
     '법률 제21065호', DATE '2026-01-02', 'https://www.law.go.kr/법령/국민건강보험법', DATE '2026-10-02',
     '법령ID 001971, MST 276651, 시행 2026-01-02 현행 슬라이스에서 조문 전문을 읽음(ST-1). 퇴직은 제10조제1항의 상실 사유가 아니라 제9조제1항제3호의 자격 변동(사용관계가 끝난 날의 다음 날)이고, 제9조제2항제2호의 14일 신고 의무는 세대주에게 있다. 사용자에게 적용되는 조항(제10조제2항·시행규칙 제4조제4항제2호)은 미확인(노무사 #9). 기산일(마지막 근무일 다음 날 0시, 민법 §157 단서로 초일 산입)과 14일 계산은 판단(J).'),

    ('SEPARATION_CERTIFICATE_DUE_DAYS', DATE '2026-09-18', 'DAYS', 10, 1,
     '고용보험법 시행규칙', '제82조의2제2항 「이직확인서 발급요청서를 제출받은 사업주는 제출받은 날부터 10일 이내에 별지 제75호의4서식에 따른 피보험자 이직확인서를 발급해야 한다」',
     '고용노동부령 제479호', DATE '2026-09-18', 'https://www.law.go.kr/법령/고용보험법시행규칙', DATE '2026-10-02',
     '법령ID 006288, MST 288723, 시행 2026-09-18 현행 슬라이스에서 조문 전문을 읽음(ST-1). 근거 법률은 고용보험법 제42조제3항. 기한은 별지 제75호의3서식 발급요청서를 받은 날부터 진행한다. 같은 항 단서: 직업안정기관에 이직확인서를 제출하거나 근로내용 확인신고서를 제출하면 발급한 것으로 본다. 제5항: 직업안정기관의 요청을 받은 날부터 10일 이내 제출. 2028-01-01 시행 고용보험법 제45조 개정(보수일액 기준)은 이직확인서의 월 보수 기재를 급여 산정에 쓰므로 그 전에 재검토.');

REVOKE ALL ON statutory_rules FROM PUBLIC;
GRANT SELECT ON statutory_rules TO console_rt;

-- ---------------------------------------------------------------------------
-- 2. insurance_loss_codes: the 상실 code tables of the three insurers.
--
-- Only 고용보험 rows are drafted. Their only source so far is secondary
-- (decisions-exits-research §4 Table A [U]); the current official form was not
-- reached. 국민연금 and 건강보험 상실부호 have no source yet, so NO rows are
-- drafted for them: a lookup fails closed until the 노무사 supplies the tables
-- (EXT-1). An exit payload records the row's effective_from as code_table_version.
CREATE TABLE insurance_loss_codes (
    insurer                TEXT NOT NULL CHECK (insurer IN ('EI', 'NPS', 'NHIS')),
    code                   TEXT NOT NULL CHECK (code ~ '^[0-9A-Z]{1,4}$'),
    effective_from         DATE NOT NULL,
    effective_to_exclusive DATE CHECK (effective_to_exclusive IS NULL OR effective_to_exclusive > effective_from),
    label_ko               TEXT NOT NULL CHECK (btrim(label_ko) <> ''),
    reason_group           TEXT NOT NULL CHECK (reason_group IN (
                               'VOLUNTARY', 'INVOLUNTARY', 'INVOLUNTARY_FAULT', 'TERM_END', 'OTHER')),
    -- Drives the note requirement (decisions #9: never a hard-coded list).
    requires_detail        BOOLEAN NOT NULL,

    instrument_ko          TEXT NOT NULL CHECK (btrim(instrument_ko) <> ''),
    article_ko             TEXT NOT NULL CHECK (btrim(article_ko) <> ''),
    promulgation_ko        TEXT NOT NULL CHECK (btrim(promulgation_ko) <> ''),
    enforced_on            DATE NOT NULL,
    source_url             TEXT NOT NULL CHECK (source_url LIKE 'https://www.law.go.kr/%'),
    retrieved_on           DATE NOT NULL,
    provenance_ko          TEXT NOT NULL CHECK (btrim(provenance_ko) <> ''),

    release_disposition    TEXT NOT NULL DEFAULT 'HOLD' CHECK (release_disposition IN ('HOLD', 'RELEASED')),
    review_receipt_ref     TEXT CHECK (review_receipt_ref IS NULL OR btrim(review_receipt_ref) <> ''),
    CONSTRAINT insurance_loss_codes_receipt_iff_released
        CHECK ((release_disposition = 'RELEASED') = (review_receipt_ref IS NOT NULL)),
    CONSTRAINT insurance_loss_codes_not_backdated_before_instrument
        CHECK (effective_from >= enforced_on),
    PRIMARY KEY (insurer, code, effective_from)
);

COMMENT ON TABLE insurance_loss_codes IS
    '4대보험 자격상실 사유 부호 대장(BW-30/BW-08). 전역·마이그레이션 전용. 모든 행은 노무사가 현행 서식과 대조해 해제하기 전까지 HOLD.';

INSERT INTO insurance_loss_codes (
    insurer, code, effective_from, label_ko, reason_group, requires_detail,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
)
SELECT 'EI', v.code, DATE '2026-09-18', v.label_ko, v.reason_group, v.requires_detail,
       '고용보험법 시행규칙',
       '피보험자격 상실신고서 별지 서식의 상실사유 구분 — 서식 원문 미확인',
       '고용노동부령 제479호', DATE '2026-09-18',
       'https://www.law.go.kr/법령/고용보험법시행규칙', DATE '2026-10-02',
       '부호와 명칭은 2차 출처(decisions-exits-research §4 Table A [U])뿐이며 현행 서식과 대조되지 않았다. 고용보험법 시행규칙 부칙 <제338호, 2010.2.9>의 15개 부호(Table B)는 경과규정이라 현행으로 쓰지 않는다. 23/26 경계(권고사직)와 사망 부호는 노무사 확인 사항(#9). 시작일은 대조 대상 시행규칙 슬라이스(법령ID 006288)의 시행일.'
FROM (VALUES
    ('11', '개인사정으로 인한 자진퇴사', 'VOLUNTARY', FALSE),
    ('12', '사업장 이전·근로조건 변동·임금체불 등으로 자진퇴사', 'VOLUNTARY', FALSE),
    ('22', '폐업·도산·공사중단', 'INVOLUNTARY', FALSE),
    ('23', '경영상 필요 또는 회사불황으로 인원감축 등에 의한 퇴사 (해고·권고사직·명예퇴직 포함)', 'INVOLUNTARY', FALSE),
    ('26', '피보험자의 귀책사유에 의한 징계해고·권고사직 또는 계약해지', 'INVOLUNTARY_FAULT', TRUE),
    ('31', '정년', 'TERM_END', FALSE),
    ('32', '계약기간 만료·공사종료', 'TERM_END', TRUE),
    ('41', '고용보험 비적용', 'OTHER', FALSE),
    ('42', '이중고용', 'OTHER', FALSE)
) AS v(code, label_ko, reason_group, requires_detail);

REVOKE ALL ON insurance_loss_codes FROM PUBLIC;
GRANT SELECT ON insurance_loss_codes TO console_rt;

-- ---------------------------------------------------------------------------
-- 3. Personal-data classification (gate: personal-data-classification).
COMMENT ON COLUMN statutory_rules.code IS 'pd:none — global statutory-rule key; no natural-person row';
COMMENT ON COLUMN statutory_rules.effective_from IS 'pd:none — statutory effective date; no natural-person row';
COMMENT ON COLUMN statutory_rules.effective_to_exclusive IS 'pd:none — statutory effective-date bound; no natural-person row';
COMMENT ON COLUMN statutory_rules.unit IS 'pd:none — statutory unit enum; no natural-person row';
COMMENT ON COLUMN statutory_rules.value_num IS 'pd:none — statutory value numerator; no natural-person row';
COMMENT ON COLUMN statutory_rules.value_den IS 'pd:none — statutory value denominator; no natural-person row';
COMMENT ON COLUMN statutory_rules.instrument_ko IS 'pd:none — public statutory instrument citation; no natural-person row';
COMMENT ON COLUMN statutory_rules.article_ko IS 'pd:none — public statutory article citation; no natural-person row';
COMMENT ON COLUMN statutory_rules.promulgation_ko IS 'pd:none — public promulgation identifier; no natural-person row';
COMMENT ON COLUMN statutory_rules.enforced_on IS 'pd:none — statutory enforcement date; no natural-person row';
COMMENT ON COLUMN statutory_rules.source_url IS 'pd:none — public law source URL; no natural-person row';
COMMENT ON COLUMN statutory_rules.retrieved_on IS 'pd:none — public-source retrieval date; no natural-person row';
COMMENT ON COLUMN statutory_rules.provenance_ko IS 'pd:none — public-source provenance note; no natural-person row';
COMMENT ON COLUMN statutory_rules.release_disposition IS 'pd:none — HOLD/RELEASED review state; no natural-person row';
COMMENT ON COLUMN statutory_rules.review_receipt_ref IS 'pd:none — jurisdiction-register receipt id, never a reviewer name; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.insurer IS 'pd:none — insurer enum; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.code IS 'pd:none — public insurer loss-reason code; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.effective_from IS 'pd:none — code-table effective date; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.effective_to_exclusive IS 'pd:none — code-table effective-date bound; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.label_ko IS 'pd:none — public loss-reason label; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.reason_group IS 'pd:none — loss-reason group enum; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.requires_detail IS 'pd:none — whether a note is required; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.instrument_ko IS 'pd:none — public statutory instrument citation; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.article_ko IS 'pd:none — public statutory article citation; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.promulgation_ko IS 'pd:none — public promulgation identifier; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.enforced_on IS 'pd:none — statutory enforcement date; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.source_url IS 'pd:none — public law source URL; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.retrieved_on IS 'pd:none — public-source retrieval date; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.provenance_ko IS 'pd:none — public-source provenance note; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.release_disposition IS 'pd:none — HOLD/RELEASED review state; no natural-person row';
COMMENT ON COLUMN insurance_loss_codes.review_receipt_ref IS 'pd:none — jurisdiction-register receipt id, never a reviewer name; no natural-person row';

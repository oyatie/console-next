-- SPDX-License-Identifier: LicenseRef-Proprietary
-- REFDATA-2027 S1. Retrieved 2026-10-27 with a generic User-Agent, no account/key.
-- All rows remain CTRL-KR-WORKFORCE-001 HOLD; 2028-01-01 is an annual review bound.
-- EI history: https://www.law.go.kr/LSW/lsHstListR.do?lsId=009842
-- Latest slice is 20251223 / 제35935호. MOEL news_seq=19866 announces 2.0%,
-- but no promulgated 2027 decree was found; the coverage watch expires 2026-12-24.
-- No placeholder LTC, health band or withholding row: dated waivers live in
-- tests/statutory_coverage.rs. Employer accident rates remain uncomputed.
INSERT INTO payroll_statutory_rates (
    code, effective_from, effective_to_exclusive, rate_num, rate_den, floor_won, cap_won,
    basis, bearer, instrument_ko, article_ko, promulgation_ko, enforced_on, source_url,
    retrieved_on, provenance_ko
) VALUES
    ('NATIONAL_PENSION_EMPLOYEE', '2027-01-01', '2028-01-01', 500, 10000, NULL, NULL, 'PENSION_STANDARD_INCOME', 'EMPLOYEE_WHOLE',
     '국민연금법', '부칙 <법률 제20903호> 제4조제1항제2호: 2027년은 1만분의 500; 제117조 단수 처리', '법률 제22096호',
     '2027-01-01', 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=291347&efYd=20270101', '2026-10-27',
     '2026-10-27 LSW 20270101 시행본(법률 제22096호)을 읽음. 부칙 <법률 제20903호> 제4조제1항제2호 500/10000, 제117조의 10원 미만 단수 처리 확인. 연간 재검토 경계 2028-01-01, CTRL-KR-WORKFORCE-001 HOLD.'),
    ('HEALTH_INSURANCE_TOTAL', '2027-01-01', '2028-01-01', 719, 10000, NULL, NULL, 'MONTHLY_REMUNERATION', 'HALF_EACH',
     '국민건강보험법 시행령', '제44조제1항: 1만분의 719; 법률 제21687호 20270101 제76조제1항 50/50, 제107조 끝수 처리', '대통령령 제36675호',
     '2027-01-01', 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=289701&efYd=20270101', '2026-10-27',
     '2026-10-27 LSW 20270101 시행본을 읽음. 대통령령 제36675호 제44조제1항 719/10000, 법률 제21687호 제76조제1항 분담·제107조 끝수 확인. 2027 상·하한 고시 UNVERIFIED: 밴드가 없으면 HEALTH_PREMIUM_BAND_MISSING. CTRL-KR-WORKFORCE-001 HOLD.'),
    ('EMPLOYMENT_INSURANCE_EMPLOYEE', '2027-01-01', '2028-01-01', 9, 1000, NULL, NULL, 'MONTHLY_REMUNERATION', 'EMPLOYEE_WHOLE',
     '고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률 시행령', '제12조제1항제2호 실업급여 18/1000; 법률 제21472호 20270101 제13조제2항 보수·근로자 1/2 부담', '대통령령 제35935호',
     '2025-12-23', 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=280527&efYd=20251223', '2026-10-27',
     '2026-10-27 LSW lsHstListR.do?lsId=009842 재확인: 최신 시행령 제35935호(20251223) 제12조제1항제2호 18/1000, 근로자 9/1000. 법률 제21472호 20270101 제13조제2항의 보수·2분의 1 부담 확인. 고용노동부 발표 https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=19866 의 2027 총 2.0%는 미공포 UNVERIFIED; 2026-12-24 재확인 만료. CTRL-KR-WORKFORCE-001 HOLD.'),
    ('INDUSTRIAL_ACCIDENT_EMPLOYEE', '2027-01-01', '2028-01-01', 0, 1, NULL, NULL, 'INDUSTRY_TARIFF', 'EMPLOYER_ONLY',
     '고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률', '제13조제5항: 사업주가 개인별 보수에 산재보험료율을 곱한 금액 부담. 근로자 부담 조항 없음. 2027 사업종류별 요율 고시 미발견(UNVERIFIED)', '법률 제21472호',
     '2027-01-01', 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=284441&efYd=20270101', '2026-10-27',
     '2026-10-27 LSW 법률 제21472호 20270101 제13조제5항 확인. 0/1은 근로자 부담만 뜻하며 사업주 금액은 NULL. 2027 사업종류별 요율 고시는 미발견 UNVERIFIED, 사업주 요율 미탑재. CTRL-KR-WORKFORCE-001 HOLD.'),
    ('MINIMUM_WAGE', '2027-01-01', '2028-01-01', NULL, NULL, 10700, 2236300, 'MONTHLY_REMUNERATION', 'NOT_APPLICABLE',
     '2027년 적용 최저임금 고시', '1. 모든 산업 시간급 10,700원 · 월 환산액 2,236,300원(209시간) · 2. 업종 구분·도급제 별도 적용 없음 · 3. 적용기간 2027.1.1.~2027.12.31.', '고용노동부고시 제2026-60호 (발령 2026. 8. 5.)',
     '2027-01-01', 'https://www.law.go.kr/LSW/admRulInfoR.do?admRulSeq=2100000283564', '2026-10-27',
     '2026-10-27 LSW 고시 본문·첨부 PDF(flSeq 167847381)를 읽음. floor_won=시간급, cap_won=209시간 월 환산액. CTRL-KR-WORKFORCE-001 HOLD.');

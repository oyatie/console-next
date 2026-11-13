-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Add historical reference rows without changing existing data or schema.
-- Additive data only: restore dated service thresholds without altering released rows.
-- Tier A: https://www.law.go.kr/LSW/lsRvsDocListP.do?chrClsCd=010202&lsId=009883&lsRvsGubun=all
-- Article 4(1)'s one-year minimum is unchanged in the 2007 and 2012 texts:
-- https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=78373&efYd=20070411
-- https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=115301&efYd=20120726
-- The history records commencement on 2005-12-01; the 2011 full revision
-- commenced on 2012-07-26. Subsequent amendments leave this minimum unchanged.
WITH history(effective_from, law_number, promulgated_on) AS (VALUES
    (DATE '2005-12-01', '7636', DATE '2005-07-29'),
    (DATE '2007-04-11', '8372', DATE '2007-04-11'),
    (DATE '2008-02-29', '8863', DATE '2008-02-29'),
    (DATE '2008-03-28', '9039', DATE '2008-03-28'),
    (DATE '2009-02-04', '8635', DATE '2007-08-03'),
    (DATE '2010-07-05', '10339', DATE '2010-06-04'),
    (DATE '2010-11-18', '10303', DATE '2010-05-17'),
    (DATE '2012-06-11', '10366', DATE '2010-06-10'),
    (DATE '2012-07-26', '10967', DATE '2011-07-25'),
    (DATE '2018-07-01', '15664', DATE '2018-06-12'),
    (DATE '2020-05-26', '17326', DATE '2020-05-26'),
    (DATE '2022-04-14', '18038', DATE '2021-04-13'),
    (DATE '2022-07-12', '18752', DATE '2022-01-11'),
    (DATE '2025-11-11', '21135', DATE '2025-11-11')
), slices AS (
    SELECT *, lead(effective_from, 1, DATE '2026-07-01') OVER (ORDER BY effective_from) AS until
    FROM history
)
INSERT INTO statutory_rules (
    code, effective_from, effective_to_exclusive, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
)
SELECT 'SEVERANCE_MIN_SERVICE_YEARS', effective_from, until, 'YEARS', 1, 1,
    '근로자퇴직급여 보장법', '제4조제1항 단서 — 계속근로기간 1년 미만 근로자 제외',
    '법률 제' || law_number || '호', effective_from,
    'https://www.law.go.kr/법령/근로자퇴직급여보장법/(' || to_char(effective_from, 'YYYYMMDD') || ',' || lpad(law_number, 5, '0') || ',' || to_char(promulgated_on, 'YYYYMMDD') || ')/제4조',
    DATE '2026-11-12',
    '국가법령정보센터 제정·개정문 연혁과 제4조제1항 대조: 2005-12-01 시행 후 1년 미만 제외 기준 유지. 2012-07-26 전부개정 시행 이후에도 동일. 민법 제160조 경계일 판단은 노무사 검토 전.'
FROM slices;

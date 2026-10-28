-- SPDX-License-Identifier: LicenseRef-Proprietary
-- REFDATA-2027 S2; retrieved_on: 2026-10-27, generic User-Agent, no account/key.
-- Primary: 우주항공청 공고 제2026-0078호 (2026-06-29), 2027년 월력요항 p.4.
-- https://www.kasa.go.kr/bbs/BBSMSTR_000000000018/view.do?nttId=B000000003234Li6nD2
-- Read through the issuing agency's attachment viewer (the direct download returns an error page):
-- https://www.kasa.go.kr/SynapDocViewServer/job?fid=FILE_000000004405Ot5&filePath=https%3A%2F%2Fwww.kasa.go.kr%2Fcmm%2Ffms%2FFileDown.do%3FatchFileId%3DFILE_000000004405Ot5%26fileSn%3D1&convertType=0&fileType=URL
-- Decree text: 관공서의 공휴일에 관한 규정, 대통령령 제36290호 (2026-04-30), §2/§3.
-- https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=285779&efYd=20260511
-- Enforced 2026-05-01 (제2조 단서·제2호: 2026-05-11), before every 2027 date.
-- All 24 rows remain CTRL-KR-WORKFORCE-001 HOLD; edition 2027 is bounded to
-- [2027-01-01, 2028-01-01), the annual review boundary. No guessed later edition.
-- §3①1 includes 노동절 (§2 제6호); §3①2 applies to 설/추석 on Sunday only.
-- 현충일 (§2 제8호) is outside §3①1. Later temporary holidays need a new migration.
INSERT INTO attendance_public_holidays (holiday_date, name, kind, substitute_for, basis, edition) VALUES
    ('2027-01-01', '1월 1일', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제3호', '2027'),
    ('2027-02-06', '설날 연휴', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제4호', '2027'),
    ('2027-02-07', '설날', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제4호', '2027'),
    ('2027-02-08', '설날 연휴', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제4호', '2027'),
    ('2027-02-09', '설날 대체공휴일', 'SUBSTITUTE', '2027-02-07', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제2호', '2027'),
    ('2027-03-01', '삼일절', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제2호', '2027'),
    ('2027-05-01', '노동절', 'LABOR_DAY', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제6호 · 노동절 제정에 관한 법률', '2027'),
    ('2027-05-03', '노동절 대체공휴일', 'SUBSTITUTE', '2027-05-01', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제1호', '2027'),
    ('2027-05-05', '어린이날', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제7호', '2027'),
    ('2027-05-13', '부처님 오신 날', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제5호', '2027'),
    ('2027-06-06', '현충일', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제8호', '2027'),
    ('2027-07-17', '제헌절', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제2호', '2027'),
    ('2027-07-19', '제헌절 대체공휴일', 'SUBSTITUTE', '2027-07-17', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제1호', '2027'),
    ('2027-08-15', '광복절', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제2호', '2027'),
    ('2027-08-16', '광복절 대체공휴일', 'SUBSTITUTE', '2027-08-15', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제1호', '2027'),
    ('2027-09-14', '추석 연휴', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제9호', '2027'),
    ('2027-09-15', '추석', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제9호', '2027'),
    ('2027-09-16', '추석 연휴', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제9호', '2027'),
    ('2027-10-03', '개천절', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제2호', '2027'),
    ('2027-10-04', '개천절 대체공휴일', 'SUBSTITUTE', '2027-10-03', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제1호', '2027'),
    ('2027-10-09', '한글날', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제2호', '2027'),
    ('2027-10-11', '한글날 대체공휴일', 'SUBSTITUTE', '2027-10-09', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제1호', '2027'),
    ('2027-12-25', '기독탄신일', 'NATIONAL', NULL, '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제2조 제10호', '2027'),
    ('2027-12-27', '기독탄신일 대체공휴일', 'SUBSTITUTE', '2027-12-25', '관공서의 공휴일에 관한 규정(대통령령 제36290호) 제3조 제1항 제1호', '2027');

-- Correct citation text only; retain every 2026 date, kind and substitute link.
UPDATE attendance_public_holidays SET basis = '관공서 규정 제2조 제3호'
WHERE holiday_date = '2026-01-01' AND edition = '2026';
UPDATE attendance_public_holidays
SET basis = '관공서의 공휴일에 관한 규정(대통령령 제36290호) ' || CASE holiday_date
    WHEN '2026-05-01' THEN '제2조 제6호 · 노동절 제정에 관한 법률 · 금요일이라 대체 해당 없음'
    WHEN '2026-05-05' THEN '제2조 제7호'
    WHEN '2026-06-03' THEN '제2조 제10호의2'
    WHEN '2026-06-06' THEN '제2조 제8호 · 대체 없음'
    WHEN '2026-09-24' THEN '제2조 제9호'
    WHEN '2026-09-25' THEN '제2조 제9호'
    WHEN '2026-09-26' THEN '제2조 제9호 · 토요일이라 대체 해당 없음'
    ELSE replace(basis, '관공서 규정 ', '') END
WHERE edition = '2026' AND holiday_date >= '2026-05-01' AND holiday_date < '2027-01-01';

COMMENT ON TABLE attendance_public_holidays IS
    '관공서의 공휴일에 관한 규정 제2조(일요일 제외)·제3조 및 노동절 제정에 관한 법률. 대통령령 제36290호부터 노동절도 토·일요일과 겹치면 대체공휴일 적용. 연도별 공식 월력요항을 이관하며 미적재 연도는 NOT LOADED. 기준 자료는 CTRL-KR-WORKFORCE-001 HOLD.';

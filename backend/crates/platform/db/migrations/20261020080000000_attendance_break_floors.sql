-- SPDX-License-Identifier: LicenseRef-Proprietary
-- MB-2: 근로기준법 §54① break floor as dated register rows, plus the 4-hour
-- waiver (법률 제21784호, §54 시행 2026-12-10). Global, migration-only,
-- SELECT-only to console_rt, same posture as attendance_public_holidays.
-- A date with no row in force fails closed. The waiver row applies only when
-- the worker explicitly asks to skip the break; the 4-hour and 8-hour rows
-- stay open because the main clause does.
SET LOCAL lock_timeout = '2s';

CREATE TABLE attendance_break_floors (
    code                   TEXT NOT NULL CHECK (code IN (
                               'lsa.s54.at_4h',
                               'lsa.s54.at_8h',
                               'lsa.s54.waiver_4h')),
    effective_from         DATE NOT NULL,
    effective_to_exclusive DATE CHECK (effective_to_exclusive IS NULL OR effective_to_exclusive > effective_from),
    work_minutes           INTEGER NOT NULL CHECK (work_minutes BETWEEN 0 AND 1440),
    rest_minutes           INTEGER NOT NULL CHECK (rest_minutes BETWEEN 0 AND 1440),
    waiver                 BOOLEAN NOT NULL,
    instrument_ko          TEXT NOT NULL CHECK (btrim(instrument_ko) <> ''),
    article_ko             TEXT NOT NULL CHECK (btrim(article_ko) <> ''),
    promulgation_ko        TEXT NOT NULL CHECK (btrim(promulgation_ko) <> ''),
    enforced_on            DATE NOT NULL,
    source_url             TEXT NOT NULL CHECK (source_url LIKE 'https://www.law.go.kr/%'),
    retrieved_on           DATE NOT NULL,
    provenance_ko          TEXT NOT NULL CHECK (btrim(provenance_ko) <> ''),
    CONSTRAINT attendance_break_floors_not_backdated_before_instrument
        CHECK (effective_from >= enforced_on),
    PRIMARY KEY (code, effective_from)
);

COMMENT ON TABLE attendance_break_floors IS
    '근로기준법 제54조 휴게 하한. 전역·마이그레이션 전용. 날짜로 고르며 코드 상수로 두지 않는다.';
COMMENT ON COLUMN attendance_break_floors.code IS 'pd:none — lsa.s54 band key';
COMMENT ON COLUMN attendance_break_floors.effective_from IS 'pd:none — first day the row is in force';
COMMENT ON COLUMN attendance_break_floors.effective_to_exclusive IS 'pd:none — first day the row is no longer in force';
COMMENT ON COLUMN attendance_break_floors.work_minutes IS 'pd:none — worked minutes that select the band';
COMMENT ON COLUMN attendance_break_floors.rest_minutes IS 'pd:none — minimum break minutes for the band';
COMMENT ON COLUMN attendance_break_floors.waiver IS 'pd:none — exact-length proviso, only with an explicit request';
COMMENT ON COLUMN attendance_break_floors.instrument_ko IS 'pd:none — statute name';
COMMENT ON COLUMN attendance_break_floors.article_ko IS 'pd:none — cited article text';
COMMENT ON COLUMN attendance_break_floors.promulgation_ko IS 'pd:none — promulgation';
COMMENT ON COLUMN attendance_break_floors.enforced_on IS 'pd:none — 시행일 of the cited slice';
COMMENT ON COLUMN attendance_break_floors.source_url IS 'pd:none — law.go.kr source';
COMMENT ON COLUMN attendance_break_floors.retrieved_on IS 'pd:none — day the slice was read';
COMMENT ON COLUMN attendance_break_floors.provenance_ko IS 'pd:none — which slice was read';

REVOKE ALL PRIVILEGES ON attendance_break_floors FROM PUBLIC, console_rt;
GRANT SELECT ON attendance_break_floors TO console_rt;

INSERT INTO attendance_break_floors (
    code, effective_from, work_minutes, rest_minutes, waiver,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko
) VALUES
    ('lsa.s54.at_4h', DATE '2026-10-08', 240, 30, FALSE,
     '근로기준법',
     '제54조제1항 「사용자는 근로시간이 4시간인 경우에는 30분 이상, 8시간인 경우에는 1시간 이상의 휴게시간을 근로시간 도중에 주어야 한다」 — 이 행은 4시간 대역',
     '법률 제21533호', DATE '2026-10-08',
     'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-20',
     '법령ID 001872, MST 285279, 시행 2026-10-08 현행 슬라이스. 조문은 law.md(2026-10-20 law.go.kr DRF)에 인용된 제54조제1항 본문. 240분·30분은 그 문장의 4시간·30분.'),
    ('lsa.s54.at_8h', DATE '2026-10-08', 480, 60, FALSE,
     '근로기준법',
     '제54조제1항 「사용자는 근로시간이 4시간인 경우에는 30분 이상, 8시간인 경우에는 1시간 이상의 휴게시간을 근로시간 도중에 주어야 한다」 — 이 행은 8시간 대역',
     '법률 제21533호', DATE '2026-10-08',
     'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-20',
     '법령ID 001872, MST 285279, 시행 2026-10-08 현행 슬라이스. 조문은 law.md(2026-10-20 law.go.kr DRF)에 인용된 제54조제1항 본문. 480분·60분은 그 문장의 8시간·1시간.'),
    ('lsa.s54.waiver_4h', DATE '2026-12-10', 240, 0, TRUE,
     '근로기준법',
     '제54조제1항 단서 「다만, 근로시간이 4시간인 경우로서 근로자가 휴게시간을 이용하지 아니할 것을 명시적으로 요청한 때에는 그러하지 아니하다」',
     '법률 제21784호', DATE '2026-12-10',
     'https://www.law.go.kr/법령/근로기준법', DATE '2026-10-20',
     '법령ID 001872, MST 286771, 법률 제21784호(공포 2026-06-09) 중 제54조는 부칙에 따라 2026-12-10 시행. 조문은 law.md에 인용된 단서. 요청 기록이 없으면 이 행은 적용하지 않고 lsa.s54.at_4h가 남는다.');

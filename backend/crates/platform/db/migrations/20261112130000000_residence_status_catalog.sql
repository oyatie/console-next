-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Seed new public reference tables; no existing records or N-1 readers change.
-- Source: 출입국관리법 시행령, 시행 2026-10-02, 대통령령 제36728호.
-- Read from law.go.kr: 별표 1 (2019-06-11), 별표 1의2 (2026-09-15), 별표 1의3 (2023-12-12).
-- https://www.law.go.kr/LSW/flDownload.do?flSeq=169633205
-- https://www.law.go.kr/LSW/flDownload.do?flSeq=169633213
-- https://www.law.go.kr/LSW/flDownload.do?flSeq=169633481
-- Exactly 5 short-stay + 31 long-stay + 1 permanent status; no C-2 or visa subcategories.
-- English labels are display translations of the Korean status names, not statutory English text.
-- valid_from is the verified decree edition's effective date, not the code's original introduction.
-- Intervals are [valid_from, valid_to). Global public reference data, owned by migrations.
SET LOCAL lock_timeout = '2s';

CREATE TABLE residence_status_codes (
    code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]-[1-9][0-9]*$')
);
CREATE TABLE residence_status_versions (
    code TEXT NOT NULL REFERENCES residence_status_codes(code) ON DELETE RESTRICT,
    label_ko TEXT NOT NULL CHECK (btrim(label_ko) <> ''),
    label_en TEXT NOT NULL CHECK (btrim(label_en) <> ''),
    publisher TEXT NOT NULL CHECK (btrim(publisher) <> ''),
    valid_from DATE NOT NULL,
    valid_to DATE CHECK (valid_to > valid_from),
    PRIMARY KEY (code, valid_from)
);
CREATE UNIQUE INDEX residence_status_versions_current ON residence_status_versions(code) WHERE valid_to IS NULL;
COMMENT ON TABLE residence_status_codes IS 'Global residence-status identities from the Immigration Act Enforcement Decree; retained for historical references';
COMMENT ON COLUMN residence_status_codes.code IS 'pd:none — official residence-status identity';
COMMENT ON TABLE residence_status_versions IS 'Global dated residence-status labels; no insurance or employment applicability rules';
COMMENT ON COLUMN residence_status_versions.code IS 'pd:none — official residence-status identity';
COMMENT ON COLUMN residence_status_versions.label_ko IS 'pd:none — statutory Korean status name';
COMMENT ON COLUMN residence_status_versions.label_en IS 'pd:none — English display translation';
COMMENT ON COLUMN residence_status_versions.publisher IS 'pd:none — code list publisher';
COMMENT ON COLUMN residence_status_versions.valid_from IS 'pd:none — inclusive verified edition validity start';
COMMENT ON COLUMN residence_status_versions.valid_to IS 'pd:none — exclusive validity end; NULL is open';
REVOKE ALL ON residence_status_codes, residence_status_versions FROM PUBLIC, console_rt;
GRANT SELECT ON residence_status_codes, residence_status_versions TO console_rt;

WITH labels(code, label_ko, label_en) AS (VALUES
    -- 별표 1: 단기체류자격.
    ('B-1', '사증면제', 'Visa exemption'),
    ('B-2', '관광·통과', 'Tourism and transit'),
    ('C-1', '일시취재', 'Temporary journalism'),
    ('C-3', '단기방문', 'Short-term visit'),
    ('C-4', '단기취업', 'Short-term employment'),
    -- 별표 1의2: 장기체류자격 (20의2 계절근로 포함).
    ('A-1', '외교', 'Diplomacy'),
    ('A-2', '공무', 'Official duty'),
    ('A-3', '협정', 'Agreements'),
    ('D-1', '문화예술', 'Culture and arts'),
    ('D-2', '유학', 'Study'),
    ('D-3', '기술연수', 'Technical training'),
    ('D-4', '일반연수', 'General training'),
    ('D-5', '취재', 'Journalism'),
    ('D-6', '종교', 'Religious activities'),
    ('D-7', '주재', 'Intra-company transfer'),
    ('D-8', '기업투자', 'Corporate investment'),
    ('D-9', '무역경영', 'Trade and management'),
    ('D-10', '구직', 'Job seeking'),
    ('E-1', '교수', 'Professorship'),
    ('E-2', '회화지도', 'Foreign language instruction'),
    ('E-3', '연구', 'Research'),
    ('E-4', '기술지도', 'Technical instruction'),
    ('E-5', '전문직업', 'Professional employment'),
    ('E-6', '예술흥행', 'Arts and entertainment'),
    ('E-7', '특정활동', 'Specific activities'),
    ('E-8', '계절근로', 'Seasonal work'),
    ('E-9', '비전문취업', 'Non-professional employment'),
    ('E-10', '선원취업', 'Seafarer employment'),
    ('F-1', '방문동거', 'Visiting and joining family'),
    ('F-2', '거주', 'Residence'),
    ('F-3', '동반', 'Dependent family'),
    ('F-4', '재외동포', 'Overseas Korean'),
    ('F-6', '결혼이민', 'Marriage immigration'),
    ('H-1', '관광취업', 'Working holiday'),
    ('H-2', '방문취업', 'Work and visit'),
    ('G-1', '기타', 'Miscellaneous'),
    -- 별표 1의3: 영주자격에 부합하는 사람.
    ('F-5', '영주', 'Permanent residence')
), identities AS (
    INSERT INTO residence_status_codes(code) SELECT code FROM labels RETURNING code
)
INSERT INTO residence_status_versions(code, label_ko, label_en, publisher, valid_from)
SELECT labels.code, label_ko, label_en, '법무부', DATE '2026-10-02'
FROM labels JOIN identities USING (code);

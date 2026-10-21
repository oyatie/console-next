-- MR-23 (EMP-FACTS): the 근로자 명부 items no other table holds.
--
-- 근로기준법 §41① (법률 21857, MST 290781): 사용자는 각 사업장별로 근로자 명부를
-- 작성하고 성명, 생년월일, 이력, 그 밖에 대통령령으로 정하는 사항을 적어야 한다;
-- ② 적을 사항이 변경된 경우 지체 없이 정정. 시행령 §20 (MST 270551): 1 성명 ·
-- 2 성별 · 3 생년월일 · 4 주소 · 5 이력 · 6 종사하는 업무의 종류 · 7 고용 ·
-- 8 해고·퇴직·사망한 경우 그 연월일과 사유 · 9 그 밖에 필요한 사항.
-- 시행규칙 §16 별지 제16호서식 (MST 269393): 주소 (전화번호), 이력 [경력 · 기타].
-- Basis: 개인정보 보호법 §15①2 (법령상 의무), so no consent screen. No
-- 주민등록번호/외국인등록번호 value is stored here or anywhere (§24, §24조의2).
--
-- 1. employee_addresses: the 주소 (L-4) as an immutable structured row, the
--    same KrAddress shape as entity_addresses (juso result or structured
--    manual entry, MANUAL_UNVERIFIED) but HR-owned and pd:personal. A changed
--    address is a new row; the old one stays as history.
-- 2. employee_register_facts: one row per employee. NULL = 미입력 (never
--    defaulted). career_none: NULL 미입력, TRUE 「경력 없음」, FALSE = the
--    employee_careers rows. exit_reason_code: the BW-07 exit_reason catalog
--    code for an exit recorded without an exit case (imported 퇴사자); the
--    application refuses it unless the employee is EXITED with no live exit
--    case (the case's own exit_reason_code is the 사유 then, BW-08).
-- 3. employee_careers: 이력 · 경력 (L-5) rows. A correction replaces the live
--    list: the old rows are voided (kept), the new ones inserted.
-- 4. employee_corrections.field admits the register items beside MR-8's
--    scalar fields, so every change of them is one ledger row (old value,
--    new value, who, why; a NULL old value is a first recording).
--
-- 종사 업무 (L-6) stays employees.job (MR-8 corrects it; MR-25 types it).
-- 생년월일 (L-3) is EMP-MODEL's employees.birth_date. No seed rows. Numbered
-- head+1 of the lane's stack (0267, MR-8); INTEG renumbers it.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. employee_addresses
CREATE TABLE employee_addresses (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id     UUID        NOT NULL,
    source          TEXT        NOT NULL CHECK (source IN ('JUSO', 'MANUAL_UNVERIFIED')),
    road_addr_part1 TEXT        NOT NULL CHECK (char_length(btrim(road_addr_part1)) BETWEEN 1 AND 200),
    road_addr_part2 TEXT        NULL CHECK (road_addr_part2 IS NULL OR char_length(road_addr_part2) <= 100),
    jibun_addr      TEXT        NULL CHECK (jibun_addr IS NULL OR char_length(jibun_addr) <= 200),
    eng_addr        TEXT        NULL CHECK (eng_addr IS NULL OR char_length(eng_addr) <= 300),
    zip_no          TEXT        NULL CHECK (zip_no IS NULL OR zip_no ~ '^[0-9]{5}$'),
    adm_cd          TEXT        NULL CHECK (adm_cd IS NULL OR adm_cd ~ '^[0-9]{10}$'),
    rn_mgt_sn       TEXT        NULL CHECK (rn_mgt_sn IS NULL OR rn_mgt_sn ~ '^[0-9]{12}$'),
    bd_mgt_sn       TEXT        NULL CHECK (bd_mgt_sn IS NULL OR bd_mgt_sn ~ '^[0-9]{25}$'),
    si_nm           TEXT        NOT NULL CHECK (char_length(btrim(si_nm)) BETWEEN 1 AND 40),
    sgg_nm          TEXT        NULL CHECK (sgg_nm IS NULL OR char_length(sgg_nm) <= 40),
    emd_nm          TEXT        NULL CHECK (emd_nm IS NULL OR char_length(emd_nm) <= 40),
    li_nm           TEXT        NULL CHECK (li_nm IS NULL OR char_length(li_nm) <= 40),
    bd_nm           TEXT        NULL CHECK (bd_nm IS NULL OR char_length(bd_nm) <= 100),
    udrt_yn         BOOLEAN     NULL,
    buld_mnnm       INTEGER     NULL CHECK (buld_mnnm IS NULL OR buld_mnnm >= 0),
    buld_slno       INTEGER     NULL CHECK (buld_slno IS NULL OR buld_slno >= 0),
    mt_yn           BOOLEAN     NULL,
    lnbr_mnnm       INTEGER     NULL CHECK (lnbr_mnnm IS NULL OR lnbr_mnnm >= 0),
    lnbr_slno       INTEGER     NULL CHECK (lnbr_slno IS NULL OR lnbr_slno >= 0),
    detail          TEXT        NULL CHECK (detail IS NULL OR char_length(detail) <= 100),
    as_printed      TEXT        NULL CHECK (as_printed IS NULL OR char_length(as_printed) <= 300),
    created_by      UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employee_addresses_juso_codes CHECK (
        source <> 'JUSO' OR (zip_no IS NOT NULL AND adm_cd IS NOT NULL AND bd_mgt_sn IS NOT NULL)
    )
);
CREATE INDEX employee_addresses_employee_idx ON employee_addresses (org_id, employee_id);

-- ---------------------------------------------------------------------------
-- 2. employee_register_facts
CREATE TABLE employee_register_facts (
    org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id      UUID        NOT NULL,
    sex              TEXT        NULL CHECK (sex IN ('MALE', 'FEMALE')),
    address_id       UUID        NULL,
    career_none      BOOLEAN     NULL,
    exit_reason_code TEXT        NULL
        CHECK (exit_reason_code IS NULL OR char_length(btrim(exit_reason_code)) BETWEEN 1 AND 100),
    register_note    TEXT        NULL
        CHECK (register_note IS NULL OR (btrim(register_note) <> '' AND char_length(register_note) <= 500)),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, employee_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, address_id) REFERENCES employee_addresses (org_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 3. employee_careers
CREATE TABLE employee_careers (
    org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id            UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id   UUID        NOT NULL,
    seq           SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 100),
    employer_name TEXT        NOT NULL CHECK (btrim(employer_name) = employer_name AND char_length(employer_name) BETWEEN 1 AND 100),
    -- Months: the first day of the month (별지 16호 경력 기간 is month-grained).
    from_month    DATE        NOT NULL CHECK (EXTRACT(DAY FROM from_month) = 1),
    to_month      DATE        NULL CHECK (to_month IS NULL OR EXTRACT(DAY FROM to_month) = 1),
    position      TEXT        NULL CHECK (position IS NULL OR (btrim(position) <> '' AND char_length(position) <= 100)),
    duty          TEXT        NULL CHECK (duty IS NULL OR (btrim(duty) <> '' AND char_length(duty) <= 200)),
    leave_reason  TEXT        NULL CHECK (leave_reason IS NULL OR (btrim(leave_reason) <> '' AND char_length(leave_reason) <= 200)),
    voided_at     TIMESTAMPTZ NULL,
    created_by    UUID        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employee_careers_period CHECK (to_month IS NULL OR to_month >= from_month)
);
CREATE UNIQUE INDEX employee_careers_live_seq_key
    ON employee_careers (org_id, employee_id, seq) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. The ledger admits the register items (MR-8's list plus these five).
ALTER TABLE employee_corrections DROP CONSTRAINT employee_corrections_field_check;
ALTER TABLE employee_corrections ADD CONSTRAINT employee_corrections_field_check CHECK (field IN (
    'name', 'phone', 'job', 'work_email', 'id_type',
    'hire_date', 'exit_date', 'birth_date', 'employee_number',
    'employment_type', 'base_pay', 'pay_unit', 'probation_end_date',
    'position_id',
    -- IMPORT (MR-7) ledger rows; INTEG keeps the union with 0283.
    'position', 'worksite_name', 'worksite_address',
    'sex', 'address', 'careers', 'exit_reason', 'register_note'
));

-- ---------------------------------------------------------------------------
-- RLS, grants (no DELETE: 명부 retention, 근기법 §42 / 영 §22)
ALTER TABLE employee_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_addresses
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_addresses_org_immutable BEFORE UPDATE ON employee_addresses
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_register_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_register_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_register_facts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_register_facts_org_immutable BEFORE UPDATE ON employee_register_facts
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_careers ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_careers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_careers
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_careers_org_immutable BEFORE UPDATE ON employee_careers
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

REVOKE ALL PRIVILEGES ON employee_addresses, employee_register_facts, employee_careers
    FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON employee_addresses, employee_register_facts, employee_careers TO console_rt;
GRANT UPDATE (sex, address_id, career_none, exit_reason_code, register_note, updated_at)
    ON employee_register_facts TO console_rt;
GRANT UPDATE (voided_at) ON employee_careers TO console_rt;

-- ---------------------------------------------------------------------------
-- Classification
COMMENT ON TABLE employee_addresses IS 'MR-23 근로자 명부 주소 (영 §20 4호): immutable structured address rows; a change is a new row';
COMMENT ON COLUMN employee_addresses.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_addresses.id IS 'pd:none — row id';
COMMENT ON COLUMN employee_addresses.employee_id IS 'pd:personal — whose address; row is a natural person';
COMMENT ON COLUMN employee_addresses.source IS 'pd:none — JUSO (search result) | MANUAL_UNVERIFIED (structured manual entry)';
COMMENT ON COLUMN employee_addresses.road_addr_part1 IS 'pd:personal — 도로명주소 (home address)';
COMMENT ON COLUMN employee_addresses.road_addr_part2 IS 'pd:personal — 참고항목 (home address)';
COMMENT ON COLUMN employee_addresses.jibun_addr IS 'pd:personal — 지번주소 (home address)';
COMMENT ON COLUMN employee_addresses.eng_addr IS 'pd:personal — 영문주소 (home address)';
COMMENT ON COLUMN employee_addresses.zip_no IS 'pd:personal — 우편번호 (home address)';
COMMENT ON COLUMN employee_addresses.adm_cd IS 'pd:personal — 행정구역코드 (home address)';
COMMENT ON COLUMN employee_addresses.rn_mgt_sn IS 'pd:personal — 도로명코드 (home address)';
COMMENT ON COLUMN employee_addresses.bd_mgt_sn IS 'pd:personal — 건물관리번호 (home address)';
COMMENT ON COLUMN employee_addresses.si_nm IS 'pd:personal — 시도명 (home address)';
COMMENT ON COLUMN employee_addresses.sgg_nm IS 'pd:personal — 시군구명 (home address)';
COMMENT ON COLUMN employee_addresses.emd_nm IS 'pd:personal — 읍면동명 (home address)';
COMMENT ON COLUMN employee_addresses.li_nm IS 'pd:personal — 법정리명 (home address)';
COMMENT ON COLUMN employee_addresses.bd_nm IS 'pd:personal — 건물명 (home address)';
COMMENT ON COLUMN employee_addresses.udrt_yn IS 'pd:personal — 지하 여부 (home address)';
COMMENT ON COLUMN employee_addresses.buld_mnnm IS 'pd:personal — 건물본번 (home address)';
COMMENT ON COLUMN employee_addresses.buld_slno IS 'pd:personal — 건물부번 (home address)';
COMMENT ON COLUMN employee_addresses.mt_yn IS 'pd:personal — 산 여부 (home address)';
COMMENT ON COLUMN employee_addresses.lnbr_mnnm IS 'pd:personal — 지번본번 (home address)';
COMMENT ON COLUMN employee_addresses.lnbr_slno IS 'pd:personal — 지번부번 (home address)';
COMMENT ON COLUMN employee_addresses.detail IS 'pd:personal — 상세주소 (동·층·호)';
COMMENT ON COLUMN employee_addresses.as_printed IS 'pd:personal — the address as written on the source document';
COMMENT ON COLUMN employee_addresses.created_by IS 'pd:personal — user who recorded the address';
COMMENT ON COLUMN employee_addresses.created_at IS 'pd:none — when the row was recorded';

COMMENT ON TABLE employee_register_facts IS 'MR-23 근로자 명부 items held nowhere else (영 §20 2·4·5·8·9호); NULL = 미입력';
COMMENT ON COLUMN employee_register_facts.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_register_facts.employee_id IS 'pd:personal — the employee; row is a natural person';
COMMENT ON COLUMN employee_register_facts.sex IS 'pd:personal — 성별 (영 §20 2호): MALE | FEMALE; NULL = 미입력';
COMMENT ON COLUMN employee_register_facts.address_id IS 'pd:personal — current 주소 (영 §20 4호), an employee_addresses row';
COMMENT ON COLUMN employee_register_facts.career_none IS 'pd:personal — 이력 (영 §20 5호): TRUE = 경력 없음, FALSE = employee_careers rows, NULL = 미입력';
COMMENT ON COLUMN employee_register_facts.exit_reason_code IS 'pd:personal — 퇴직(해고) 사유 (영 §20 8호), BW-07 exit_reason code, for an exit recorded without an exit case';
COMMENT ON COLUMN employee_register_facts.register_note IS 'pd:personal — 그 밖에 필요한 사항 (영 §20 9호), optional';
COMMENT ON COLUMN employee_register_facts.updated_at IS 'pd:none — last change';

COMMENT ON TABLE employee_careers IS 'MR-23 근로자 명부 이력 · 경력 (영 §20 5호); a correction voids the live rows and inserts the new list';
COMMENT ON COLUMN employee_careers.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_careers.id IS 'pd:none — row id';
COMMENT ON COLUMN employee_careers.employee_id IS 'pd:personal — whose career; row is a natural person';
COMMENT ON COLUMN employee_careers.seq IS 'pd:none — order within the list';
COMMENT ON COLUMN employee_careers.employer_name IS 'pd:personal — former employer (경력 회사)';
COMMENT ON COLUMN employee_careers.from_month IS 'pd:personal — 경력 시작 월';
COMMENT ON COLUMN employee_careers.to_month IS 'pd:personal — 경력 종료 월; NULL = 미입력';
COMMENT ON COLUMN employee_careers.position IS 'pd:personal — 직위 at the former employer';
COMMENT ON COLUMN employee_careers.duty IS 'pd:personal — 담당 업무 at the former employer';
COMMENT ON COLUMN employee_careers.leave_reason IS 'pd:personal — 퇴직 사유 at the former employer';
COMMENT ON COLUMN employee_careers.voided_at IS 'pd:none — replaced by a later correction (kept for 명부 history)';
COMMENT ON COLUMN employee_careers.created_by IS 'pd:personal — user who recorded the row';
COMMENT ON COLUMN employee_careers.created_at IS 'pd:none — when the row was recorded';

-- EMP-MODEL: the employee model (prototype-parity E3, E4, E5, E10, E12/F5, E13, G1).
-- Numbered head+1 of refactor/r2-people 8e705f4 (0255); INTEG renumbers at the batch merge.
-- Writer crates: `employees` DML stays with console-ontology-canonical-adapter-postgres
-- (ObjectKey::Employment; the EMP-MODEL person facts go through its employee_facts
-- module); console-hr-adapter-postgres writes employee_employment_profiles and
-- employee_contracts (hr profile/, contract/).
--
-- This is the one MVP migration that changes `employees` and
-- `employee_employment_profiles` (delivery-plan §4.1). It is frozen on commit:
-- PEOPLE, IMPORT and LIFE rebase onto it, so it also carries the head columns
-- their items name on these two tables:
--   BW-11 (LIFE)       employees.head_version
--   BW-18 (PEOPLE-A)   employees.merged_into_employee_id; UPDATE grants for corrections
--   BW-19 (IMPORT)     employees.id_type, employees.birth_date (decisions #6)
-- Deliberately NOT here:
--   * BW-10's partial unique index on (org_id, employee_number): it follows the
--     duplicate cleanup (BW-10 5), so it cannot ship before that runs.
--   * BW-13's position_id: its FK targets BW-13's own job_titles table.
--   * An encrypted RRN/ARC value. decisions #6: the legal ID is collected,
--     encrypted, only when the product performs the statutory filing; the MVP
--     files nothing, so only the identification TYPE is stored (PIPA §24-2
--     minimisation). The column comes with the filing feature.
--
-- Shape rules (H5): every new column is NULL-able or has a default, so the
-- existing INSERTs (directory create_core, the 0183 leave_api function) and the
-- `String` readers keep working. CHECK lists only grow. No backfill guesses: a
-- legacy base_pay with no period stays unlabelled (NULL unit), and a legacy
-- person has no birth date until someone records it.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. employees: person facts (E3, E4) and the head columns named above.
ALTER TABLE employees
    ADD COLUMN birth_date DATE NULL
        CONSTRAINT employees_birth_date_floor CHECK (birth_date >= DATE '1900-01-01'),
    ADD COLUMN work_email TEXT NULL
        CONSTRAINT employees_work_email_shape CHECK (
            char_length(work_email) BETWEEN 3 AND 254
            AND work_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
    ADD COLUMN id_type TEXT NULL
        CONSTRAINT employees_id_type_check CHECK (id_type IN ('RRN', 'ARC', 'DOMESTIC_RESIDENCE', 'NOT_ISSUED')),
    ADD COLUMN head_version INTEGER NOT NULL DEFAULT 0
        CONSTRAINT employees_head_version_check CHECK (head_version >= 0),
    ADD COLUMN merged_into_employee_id UUID NULL
        CONSTRAINT employees_merged_into_not_self CHECK (merged_into_employee_id <> id);
ALTER TABLE employees ADD CONSTRAINT employees_merged_into_same_org_fk
    FOREIGN KEY (merged_into_employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT;

COMMENT ON COLUMN employees.birth_date IS 'pd:personal — 생년월일 (근기법 시행령 §20 명부 기재사항; decisions #6 판별 키, 주민번호 대신)';
COMMENT ON COLUMN employees.work_email IS 'pd:personal — 업무용 이메일; 초대 주소를 미리 채우는 인사 사실일 뿐 초대 주소 자체가 아님 (mail design N5)';
COMMENT ON COLUMN employees.id_type IS 'pd:personal — 신분증명 종류만 (번호는 저장하지 않음, decisions #6); NOT_ISSUED는 취득신고 후속 항목을 연다';
COMMENT ON COLUMN employees.head_version IS 'pd:none — lifecycle head version pin (BW-11), structural';
COMMENT ON COLUMN employees.merged_into_employee_id IS 'pd:personal — 동일인 병합 대상 직원 (BW-18); 개보법 제2조제1호나목 결합 식별';

-- ---------------------------------------------------------------------------
-- 2. employee_employment_profiles: employment facts (E5, E12/F5, E13).

-- E13: one employment-type enum. The four existing values stay. 일용 is a
-- 근로자 form; 임원, 파견 받은 인력, 도급 인력 and 프리랜서 are not 근로자 of the
-- tenant by default, so worker classification is a pure derivation from this
-- one column (hr-domain profile::worker_classification) and never stored twice.
-- 단시간 as a working-time fact is the contract's weekly_minutes (§3 below).
ALTER TABLE employee_employment_profiles
    DROP CONSTRAINT IF EXISTS employee_employment_profiles_employment_type_check;
ALTER TABLE employee_employment_profiles ADD CONSTRAINT employee_employment_profiles_employment_type_check
    CHECK (employment_type IN (
        'REGULAR', 'CONTRACT', 'PART_TIME', 'INTERN',
        'DAILY', 'EXECUTIVE', 'DISPATCHED_IN', 'OUTSOURCED_ON_SITE', 'FREELANCE'));

-- E5: integer won with its unit, as a pair. base_pay NUMERIC(14,2) stays for
-- its existing readers; new writers fill both.
-- E12/F5: probation is a dated period on the employment (start = hire date),
-- not a status. It ends by the 수습 종료 confirmation recorded here.
ALTER TABLE employee_employment_profiles
    ADD COLUMN base_pay_won BIGINT NULL
        CONSTRAINT employee_employment_profiles_base_pay_won_check CHECK (base_pay_won >= 0),
    ADD COLUMN pay_unit TEXT NULL
        CONSTRAINT employee_employment_profiles_pay_unit_check CHECK (pay_unit IN ('MONTHLY', 'HOURLY', 'DAILY', 'ANNUAL')),
    ADD COLUMN probation_end_date DATE NULL,
    ADD COLUMN probation_confirmed_at TIMESTAMPTZ NULL,
    ADD COLUMN probation_confirmed_by UUID NULL,
    ADD CONSTRAINT employee_employment_profiles_pay_pair
        CHECK ((base_pay_won IS NULL) = (pay_unit IS NULL)),
    ADD CONSTRAINT employee_employment_profiles_probation_confirm_pair
        CHECK ((probation_confirmed_at IS NULL) = (probation_confirmed_by IS NULL)),
    ADD CONSTRAINT employee_employment_profiles_probation_confirm_needs_end
        CHECK (probation_confirmed_at IS NULL OR probation_end_date IS NOT NULL),
    ADD CONSTRAINT employee_employment_profiles_probation_confirmer_fk
        FOREIGN KEY (probation_confirmed_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT;
CREATE INDEX employee_employment_profiles_org_probation_end_idx
    ON employee_employment_profiles (org_id, probation_end_date)
    WHERE probation_end_date IS NOT NULL AND probation_confirmed_at IS NULL;

-- 0172 made the profile write-once and 0245 opened contract_end_date. The
-- EMP-MODEL commands (pay, probation) and BW-18 corrections need these columns.
GRANT UPDATE (employment_type, phone_e164, base_pay, base_pay_won, pay_unit,
              probation_end_date, probation_confirmed_at, probation_confirmed_by)
    ON employee_employment_profiles TO console_rt;

COMMENT ON COLUMN employee_employment_profiles.base_pay_won IS 'pd:personal — 기본급 (원, 정수); 신정법 소득 해당 여부는 base_pay와 같이 미해결';
COMMENT ON COLUMN employee_employment_profiles.pay_unit IS 'pd:personal — 기본급 단위 (월/시/일/연)';
COMMENT ON COLUMN employee_employment_profiles.probation_end_date IS 'pd:personal — 수습 종료일 (수습 시작 = 입사일); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_employment_profiles.probation_confirmed_at IS 'pd:personal — 수습 종료 확정 시각 (F5); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_employment_profiles.probation_confirmed_by IS 'pd:personal — 수습 종료를 확정한 사용자';

-- ---------------------------------------------------------------------------
-- 3. employee_contracts: contract history per employee (G1).
--
-- Append-only, like employee_contract_wages (0210): a correction is a NEW row
-- that supersedes the wrong one (one successor each), never an UPDATE. The
-- history BW-12's two-year rule folds is the non-superseded rows. Terms are the
-- 근기법 §17① items this MVP types: period, wage + unit, 소정근로시간. The full
-- term set, signing and 교부 belong to the labor-docs vertical, which replaces
-- this table; 교부 meanwhile is a BW-06 attestation (decisions #3), not a column.
-- command_id is the request's Idempotency-Key: a replay returns the stored row.
CREATE TABLE employee_contracts (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id     UUID        NOT NULL,
    command_id      UUID        NOT NULL,
    kind            TEXT        NOT NULL CHECK (kind IN (
                        'OPEN_ENDED', 'FIXED_TERM', 'PART_TIME', 'DAILY',
                        'DISPATCH_OUTSOURCING', 'EXECUTIVE_MANDATE', 'FREELANCE_SERVICE')),
    start_date      DATE        NOT NULL,
    end_date        DATE        NULL,
    wage_won        BIGINT      NOT NULL CHECK (wage_won >= 0),
    pay_unit        TEXT        NOT NULL CHECK (pay_unit IN ('MONTHLY', 'HOURLY', 'DAILY', 'ANNUAL')),
    -- 주 소정근로시간 in minutes; NULL only where no 근로계약 exists (임원 위임,
    -- 용역, 파견·도급), which the domain enforces per kind.
    weekly_minutes  INTEGER     NULL CHECK (weekly_minutes > 0 AND weekly_minutes <= 10080),
    supersedes_id   UUID        NULL,
    created_by      UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id),
    UNIQUE (org_id, employee_id, id),
    UNIQUE (org_id, supersedes_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, employee_id, supersedes_id)
        REFERENCES employee_contracts (org_id, employee_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employee_contracts_period CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT employee_contracts_fixed_term_end CHECK (kind <> 'FIXED_TERM' OR end_date IS NOT NULL),
    CONSTRAINT employee_contracts_open_ended_no_end CHECK (kind <> 'OPEN_ENDED' OR end_date IS NULL),
    CONSTRAINT employee_contracts_not_self_superseding CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
CREATE INDEX employee_contracts_employee_idx
    ON employee_contracts (org_id, employee_id, start_date DESC);

ALTER TABLE employee_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_contracts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE OR REPLACE FUNCTION employee_contracts_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'employee_contracts is append-only: % is forbidden (a correction is a superseding row)', TG_OP
        USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_employee_contracts_append_only
    BEFORE UPDATE OR DELETE ON employee_contracts
    FOR EACH ROW EXECUTE FUNCTION employee_contracts_append_only();

GRANT SELECT, INSERT ON employee_contracts TO console_rt;

COMMENT ON TABLE employee_contracts IS 'G1 근로계약 이력 (append-only; 정정은 대체 행). labor-docs 전자계약이 대체할 때까지의 MVP 계약 사실';
COMMENT ON COLUMN employee_contracts.org_id IS 'pd:personal — row is a natural person; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_contracts.id IS 'pd:personal — row is a natural person; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_contracts.employee_id IS 'pd:personal — direct employee linkage';
COMMENT ON COLUMN employee_contracts.command_id IS 'pd:personal — Idempotency-Key of the recording request; row is a natural person';
COMMENT ON COLUMN employee_contracts.kind IS 'pd:personal — 계약 종류; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_contracts.start_date IS 'pd:personal — 계약 시작일 (근기법 §17①)';
COMMENT ON COLUMN employee_contracts.end_date IS 'pd:personal — 계약 종료일 (기간제법 §4)';
COMMENT ON COLUMN employee_contracts.wage_won IS 'pd:personal — 계약 임금 (원, 정수; 근기법 §17①1); 신정법 소득 해당 여부는 base_pay와 같이 미해결';
COMMENT ON COLUMN employee_contracts.pay_unit IS 'pd:personal — 임금 단위 (월/시/일/연)';
COMMENT ON COLUMN employee_contracts.weekly_minutes IS 'pd:personal — 주 소정근로시간(분) (근기법 §17①2, §2①9 단시간 판정 입력)';
COMMENT ON COLUMN employee_contracts.supersedes_id IS 'pd:personal — 이 행이 정정하는 이전 계약 행';
COMMENT ON COLUMN employee_contracts.created_by IS 'pd:personal — user identifier for the person who recorded the contract';
COMMENT ON COLUMN employee_contracts.created_at IS 'pd:personal — timestamp associated with employee and recording user';

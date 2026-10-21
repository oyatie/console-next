-- MR-24 / MR-25 (LIFE): the five typed classification catalogs and the dated
-- 고용형태 전환. Lane number (head+1 of hard/life/e-s3b-gt 0265); INTEG
-- renumbers at merge.
--
-- MR-25. 직급 (GRADE), 직위 (TITLE), 직책 (POSITION), 직무 (JOB) and 직군
-- (JOB_FAMILY) are five tenant lists (onboarding-and-migration §3 step 3, E26;
-- decisions #21: 직급/직책 are legally dated facts changed with history).
--   * job_titles (BW-13) becomes the one typed catalog: `kind` says which list
--     a row belongs to. No seed rows; a tenant adds its own entries (inline
--     「목록에 추가」). A label is unique per tenant and kind, ignoring case.
--     BW-13's rows were the 직위 list and stay TITLE. The kind of a row never
--     changes (no UPDATE grant on it).
--   * POSITION rows ARE the tenant 직책 catalog (access-model §2.3
--     `position_kinds`): ACCT's position appointments reference these rows, so
--     there is never a second 직책 list.
--   * employees gains the current 직급, 직책, 직무 and 직군 ids beside BW-13's
--     직위 id. employees.job (근기법 시행령 §20 6호 종사하는 업무의 종류) stays
--     the display text; an APPOINT by 직무 id projects the label into it.
--   * A trigger refuses an id of another kind in each column (a GRADE row as a
--     직책, …), on employees and on the lifecycle rows.
--   * The dated changes are lifecycle events: PROMOTE (직급 and/or 직위, the
--     강등 check on either rank) and the new APPOINT (직책, 직무, 직군; 보직
--     해제 clears the 직책). Each row keeps the before and after state.
--
-- MR-24. EMPLOYMENT_TYPE_CHANGE is a dated 고용형태 전환 (a real change from
-- its date, e.g. 기간제 → 기간의 정함이 없는 근로계약, 기간제법 §5; or the
-- §4② deemed conversion recorded), not a correction of a wrong value (that is
-- BW-18's 정정). 근기법 시행령 §20 7호 records the 고용에 관한 사항 with its
-- dates, so the history is kept. A change to CONTRACT carries the new
-- contract's end (its start is the effective date); a change away from
-- CONTRACT closes the fixed-term window. The row keeps the type and window it
-- replaced, so a rescission restores them.
--
-- Scheduled rows: the from_* columns below are rewritten when the runner
-- applies the event (the head it actually met), as 0246 does for the text
-- projections.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The typed catalog
ALTER TABLE job_titles ADD COLUMN kind TEXT NOT NULL DEFAULT 'TITLE'
    CONSTRAINT job_titles_kind_check CHECK (kind IN ('GRADE', 'TITLE', 'POSITION', 'JOB', 'JOB_FAMILY'));
-- Every writer names the kind from now on.
ALTER TABLE job_titles ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE job_titles ADD CONSTRAINT job_titles_rank_kind
    CHECK (grade_rank IS NULL OR kind IN ('GRADE', 'TITLE'));
DROP INDEX job_titles_org_label_key;
CREATE UNIQUE INDEX job_titles_org_kind_label_key ON job_titles (org_id, kind, lower(label));

COMMENT ON TABLE job_titles IS 'MR-25 tenant classification catalog: 직급 GRADE, 직위 TITLE, 직책 POSITION, 직무 JOB, 직군 JOB_FAMILY; deactivated, never deleted';
COMMENT ON COLUMN job_titles.kind IS 'pd:none — which list the entry belongs to; fixed once added';

-- Some id in `ids` names a catalog row whose kind is not the matching `kinds`.
-- The import apply (leave_api.apply_employee_import_batch) and leave_api.create_employee are
-- SECURITY DEFINER with search_path = pg_catalog, and their definer may not read job_titles:
-- the predicate runs as its owner with its own search_path, and the two trigger functions
-- carry a search_path too (INTEG, with IMPORT-2's 0297 fix; FE-PAIR 15:00 / 16:35).
CREATE FUNCTION job_title_kind_mismatch(org UUID, ids UUID[], kinds TEXT[]) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM unnest(ids, kinds) AS s(id, kind)
        JOIN public.job_titles t ON t.org_id = org AND t.id = s.id
        WHERE t.kind <> s.kind)
$$;

-- ---------------------------------------------------------------------------
-- 2. employees: the current 직급, 직책, 직무, 직군 (직위 is BW-13's job_title_id)
ALTER TABLE employees
    ADD COLUMN grade_id UUID NULL,
    ADD COLUMN position_kind_id UUID NULL,
    ADD COLUMN job_id UUID NULL,
    ADD COLUMN job_family_id UUID NULL;
ALTER TABLE employees ADD CONSTRAINT employees_grade_fk
    FOREIGN KEY (org_id, grade_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;
ALTER TABLE employees ADD CONSTRAINT employees_position_kind_fk
    FOREIGN KEY (org_id, position_kind_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;
ALTER TABLE employees ADD CONSTRAINT employees_job_fk
    FOREIGN KEY (org_id, job_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;
ALTER TABLE employees ADD CONSTRAINT employees_job_family_fk
    FOREIGN KEY (org_id, job_family_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;

CREATE FUNCTION employees_classification_kinds() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF public.job_title_kind_mismatch(NEW.org_id,
        ARRAY[NEW.grade_id, NEW.job_title_id, NEW.position_kind_id, NEW.job_id, NEW.job_family_id],
        ARRAY['GRADE', 'TITLE', 'POSITION', 'JOB', 'JOB_FAMILY']) THEN
        RAISE EXCEPTION 'a classification column names a catalog entry of another kind'
            USING ERRCODE = '23514', CONSTRAINT = 'employees_classification_kind';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_employees_classification_kinds
    BEFORE INSERT OR UPDATE OF grade_id, job_title_id, position_kind_id, job_id, job_family_id ON employees
    FOR EACH ROW EXECUTE FUNCTION employees_classification_kinds();

COMMENT ON COLUMN employees.grade_id IS 'pd:personal — current 직급 (catalog GRADE); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employees.position_kind_id IS 'pd:personal — current 직책 (catalog POSITION); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employees.job_id IS 'pd:personal — current 직무 (catalog JOB), 근기법 시행령 §20 6호; employees.job keeps the text; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employees.job_family_id IS 'pd:personal — current 직군 (catalog JOB_FAMILY); 개보법 제2조제1호나목 결합 식별';

-- ---------------------------------------------------------------------------
-- 3. employee_lifecycle_events: APPOINT, EMPLOYMENT_TYPE_CHANGE and their pairs
ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_event_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_event_type_check
    CHECK (event_type IN (
        'ONBOARD', 'OFFBOARD', 'TERMINATE', 'TRANSFER',
        'PROMOTE', 'LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'CONTRACT_RENEWAL',
        'EXIT_REVERSAL', 'REHIRE', 'RESCIND', 'GROUP_TRANSFER',
        'APPOINT', 'EMPLOYMENT_TYPE_CHANGE'
    ));

ALTER TABLE employee_lifecycle_events
    ADD COLUMN from_grade_id UUID NULL,
    ADD COLUMN to_grade_id UUID NULL,
    ADD COLUMN from_position_kind_id UUID NULL,
    ADD COLUMN to_position_kind_id UUID NULL,
    ADD COLUMN from_job_id UUID NULL,
    ADD COLUMN to_job_id UUID NULL,
    ADD COLUMN from_job_family_id UUID NULL,
    ADD COLUMN to_job_family_id UUID NULL,
    ADD COLUMN from_job TEXT NULL,
    ADD COLUMN to_job TEXT NULL,
    ADD COLUMN from_employment_type TEXT NULL,
    ADD COLUMN to_employment_type TEXT NULL
        CONSTRAINT employee_lifecycle_events_to_employment_type_check CHECK (to_employment_type IN (
            'REGULAR', 'CONTRACT', 'PART_TIME', 'INTERN',
            'DAILY', 'EXECUTIVE', 'DISPATCHED_IN', 'OUTSOURCED_ON_SITE', 'FREELANCE')),
    ADD COLUMN from_contract_start_date DATE NULL;
ALTER TABLE employee_lifecycle_events
    ADD CONSTRAINT employee_lifecycle_events_from_grade_fk
        FOREIGN KEY (org_id, from_grade_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_to_grade_fk
        FOREIGN KEY (org_id, to_grade_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_from_position_kind_fk
        FOREIGN KEY (org_id, from_position_kind_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_to_position_kind_fk
        FOREIGN KEY (org_id, to_position_kind_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_from_job_fk
        FOREIGN KEY (org_id, from_job_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_to_job_fk
        FOREIGN KEY (org_id, to_job_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_from_job_family_fk
        FOREIGN KEY (org_id, from_job_family_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_to_job_family_fk
        FOREIGN KEY (org_id, to_job_family_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT employee_lifecycle_events_to_grade_event_check
        CHECK (to_grade_id IS NULL OR event_type = 'PROMOTE'),
    ADD CONSTRAINT employee_lifecycle_events_appoint_columns_check
        CHECK (event_type = 'APPOINT'
               OR (to_position_kind_id IS NULL AND to_job_id IS NULL
                   AND to_job_family_id IS NULL AND to_job IS NULL)),
    ADD CONSTRAINT employee_lifecycle_events_employment_type_event_check
        CHECK ((event_type = 'EMPLOYMENT_TYPE_CHANGE') = (to_employment_type IS NOT NULL));

-- 0243 admitted a contract end only on CONTRACT_RENEWAL; a 전환 to CONTRACT
-- carries one too (and only then).
ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT employee_lifecycle_events_contract_end_date_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_contract_end_date_check
    CHECK (CASE event_type
        WHEN 'CONTRACT_RENEWAL' THEN contract_end_date IS NOT NULL
        WHEN 'EMPLOYMENT_TYPE_CHANGE' THEN (contract_end_date IS NOT NULL) = (to_employment_type = 'CONTRACT')
        ELSE contract_end_date IS NULL END);

CREATE FUNCTION employee_lifecycle_events_classification_kinds() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF public.job_title_kind_mismatch(NEW.org_id,
        ARRAY[NEW.from_grade_id, NEW.to_grade_id, NEW.from_job_title_id, NEW.to_job_title_id,
              NEW.from_position_kind_id, NEW.to_position_kind_id, NEW.from_job_id, NEW.to_job_id,
              NEW.from_job_family_id, NEW.to_job_family_id],
        ARRAY['GRADE', 'GRADE', 'TITLE', 'TITLE', 'POSITION', 'POSITION', 'JOB', 'JOB',
              'JOB_FAMILY', 'JOB_FAMILY']) THEN
        RAISE EXCEPTION 'a classification column names a catalog entry of another kind'
            USING ERRCODE = '23514', CONSTRAINT = 'employee_lifecycle_events_classification_kind';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_employee_lifecycle_events_classification_kinds
    BEFORE INSERT OR UPDATE ON employee_lifecycle_events
    FOR EACH ROW EXECUTE FUNCTION employee_lifecycle_events_classification_kinds();

-- The runner records the head a scheduled event actually met.
GRANT UPDATE (
    from_org_unit_id, from_job_title_id, from_grade_id, from_position_kind_id, from_job_id,
    from_job_family_id, from_job, from_employment_type, from_contract_start_date,
    from_contract_end_date
) ON employee_lifecycle_events TO console_rt;

COMMENT ON COLUMN employee_lifecycle_events.from_grade_id IS 'pd:personal — 직급 before a PROMOTE (catalog GRADE); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_grade_id IS 'pd:personal — 직급 after a PROMOTE (catalog GRADE); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_position_kind_id IS 'pd:personal — 직책 before an APPOINT (catalog POSITION); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_position_kind_id IS 'pd:personal — 직책 after an APPOINT; NULL = none (보직 해제); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_job_id IS 'pd:personal — 직무 before an APPOINT (catalog JOB); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_job_id IS 'pd:personal — 직무 after an APPOINT (catalog JOB); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_job_family_id IS 'pd:personal — 직군 before an APPOINT (catalog JOB_FAMILY); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_job_family_id IS 'pd:personal — 직군 after an APPOINT (catalog JOB_FAMILY); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_job IS 'pd:personal — 종사 업무 text before an APPOINT (restored by a rescission); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_job IS 'pd:personal — 종사 업무 text after an APPOINT; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_employment_type IS 'pd:personal — 고용형태 before the event (restored by a rescission); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.to_employment_type IS 'pd:personal — 고용형태 after an EMPLOYMENT_TYPE_CHANGE (고용형태 전환); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_lifecycle_events.from_contract_start_date IS 'pd:personal — fixed-term window start before an EMPLOYMENT_TYPE_CHANGE (restored by a rescission); 개보법 제2조제1호나목 결합 식별';

-- ---------------------------------------------------------------------------
-- 4. The profile's fixed-term window moves with a 전환
GRANT UPDATE (contract_start_date) ON employee_employment_profiles TO console_rt;

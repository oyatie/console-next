-- IMPORT lane: BW-10 (import identity by 사번, per-row plan, digest-bound
-- apply, run rollback) and the BW-19 재입사 profile grant.
-- Numbered head+1 of the lane base (0256, EMP-MODEL); INTEG renumbers at the
-- batch merge.
--
-- What changes, and why (backend-work BW-10, decisions #6):
--   1. `data_import_runs` remembers the dry run the operator saw:
--      `dry_run_digest` (sha-256 of the per-row plan) and the decisions it was
--      planned with (`dry_run_decisions`: unit map, identity picks, exclusions).
--      Apply re-plans against the live roster and refuses on any difference.
--      A run can be rolled back (ROLLED_BACK) within a window, by a second
--      person (columns below; the window is a settings key, not a literal).
--   2. `import_run_row_snapshots`: what each applied row changed — the
--      before-image of an updated person, or the fact that the run inserted
--      one — so a rollback restores exactly that.
--   3. `employee_number_conflicts`: the 사번 held by more than one person
--      today, listed for BW-17 cleanup. The partial unique index on
--      `employees (org_id, employee_number)` follows that cleanup in its own
--      migration (0256 header: EMP-MODEL is the `employees` migration writer);
--      until then import and registration refuse a taken 사번 in code.
--   4. `leave_api.apply_employee_import_batch` v2 (same signature, so the leave
--      command store is unchanged): applies the plan rows, never matches by
--      file position, and never writes `employment_status`, `exit_date`,
--      `org_unit` or `name` of an existing person.
--   5. BW-19 재입사 restarts the contract window of the profile, so the runtime
--      may update `contract_start_date` (0245 opened only `contract_end_date`).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. data_import_runs: the planned dry run and the rollback.
ALTER TABLE data_import_runs DROP CONSTRAINT data_import_runs_status_check;
ALTER TABLE data_import_runs ADD CONSTRAINT data_import_runs_status_check
    CHECK (status IN ('PREVIEWED', 'DRY_RUN', 'APPLIED', 'FAILED', 'ROLLED_BACK'));
ALTER TABLE data_import_runs
    ADD COLUMN dry_run_digest TEXT NULL
        CONSTRAINT data_import_runs_dry_run_digest_shape CHECK (dry_run_digest ~ '^[0-9a-f]{64}$'),
    ADD COLUMN dry_run_decisions JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN rollback_requested_by UUID NULL,
    ADD COLUMN rollback_requested_at TIMESTAMPTZ NULL,
    ADD COLUMN rollback_reason_code TEXT NULL
        CONSTRAINT data_import_runs_rollback_reason_len CHECK (char_length(rollback_reason_code) BETWEEN 1 AND 64),
    ADD COLUMN rollback_note TEXT NULL
        CONSTRAINT data_import_runs_rollback_note_len CHECK (char_length(rollback_note) BETWEEN 1 AND 1000),
    ADD COLUMN rolled_back_by UUID NULL,
    ADD COLUMN rolled_back_at TIMESTAMPTZ NULL,
    ADD CONSTRAINT data_import_runs_rollback_request_pair
        CHECK ((rollback_requested_by IS NULL) = (rollback_requested_at IS NULL)
           AND (rollback_requested_by IS NULL) = (rollback_reason_code IS NULL)),
    ADD CONSTRAINT data_import_runs_rolled_back_pair
        CHECK ((rolled_back_by IS NULL) = (rolled_back_at IS NULL)
           AND (rolled_back_at IS NULL) = (status <> 'ROLLED_BACK')),
    -- The second person: the one who carries the rollback out is never its requester.
    ADD CONSTRAINT data_import_runs_rollback_second_person
        CHECK (rolled_back_by IS NULL OR rolled_back_by <> rollback_requested_by),
    ADD CONSTRAINT data_import_runs_rollback_requested_by_fk
        FOREIGN KEY (rollback_requested_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    ADD CONSTRAINT data_import_runs_rolled_back_by_fk
        FOREIGN KEY (rolled_back_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT;

COMMENT ON COLUMN data_import_runs.dry_run_digest IS 'pd:none — sha-256 of the per-row dry-run plan the apply is bound to (BW-10)';
COMMENT ON COLUMN data_import_runs.dry_run_decisions IS 'pd:personal — 드라이런 결정(부서 매핑, 동일인 선택, 제외 사유): 직원 id와 부서명 포함';
COMMENT ON COLUMN data_import_runs.rollback_requested_by IS 'pd:personal — 되돌리기 요청자 사용자 id';
COMMENT ON COLUMN data_import_runs.rollback_requested_at IS 'pd:none — rollback request time';
COMMENT ON COLUMN data_import_runs.rollback_reason_code IS 'pd:none — BW-07 reason code of the rollback';
COMMENT ON COLUMN data_import_runs.rollback_note IS 'pd:personal — 되돌리기 사유 메모(자유 기재, 개인정보가 섞일 수 있음)';
COMMENT ON COLUMN data_import_runs.rolled_back_by IS 'pd:personal — 되돌리기를 실행한 두 번째 사람의 사용자 id';
COMMENT ON COLUMN data_import_runs.rolled_back_at IS 'pd:none — rollback time';

-- ---------------------------------------------------------------------------
-- 2. import_run_row_snapshots: what each applied row changed.
CREATE TABLE import_run_row_snapshots (
    org_id      UUID        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    run_id      UUID        NOT NULL,
    employee_id UUID        NOT NULL,
    source_key  TEXT        NOT NULL CHECK (btrim(source_key) <> ''),
    outcome     TEXT        NOT NULL CHECK (outcome IN ('INSERTED', 'UPDATED')),
    -- UPDATED: the changed columns' values before the run; INSERTED: NULL.
    before      JSONB       NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, run_id, employee_id),
    CHECK ((outcome = 'UPDATED') = (before IS NOT NULL)),
    FOREIGN KEY (run_id, org_id) REFERENCES data_import_runs (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE CASCADE
);
CREATE INDEX import_run_row_snapshots_employee_idx
    ON import_run_row_snapshots (org_id, employee_id);
ALTER TABLE import_run_row_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_run_row_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_run_row_snapshots
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT ON import_run_row_snapshots TO console_rt;
GRANT SELECT, INSERT ON import_run_row_snapshots TO console_leave_definer;

COMMENT ON TABLE import_run_row_snapshots IS 'BW-10: per-row effect of an applied employee import, read by the run rollback';
COMMENT ON COLUMN import_run_row_snapshots.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN import_run_row_snapshots.run_id IS 'pd:none — import run';
COMMENT ON COLUMN import_run_row_snapshots.employee_id IS 'pd:personal — 반입으로 생성·수정된 직원 id';
COMMENT ON COLUMN import_run_row_snapshots.source_key IS 'pd:personal — 원본 파일·시트·행 위치 (행이 사람 한 명)';
COMMENT ON COLUMN import_run_row_snapshots.outcome IS 'pd:none — INSERTED or UPDATED';
COMMENT ON COLUMN import_run_row_snapshots.before IS 'pd:personal — 반입 전 값(업무·직위·근무지·생년월일)';
COMMENT ON COLUMN import_run_row_snapshots.created_at IS 'pd:none — write time';

-- ---------------------------------------------------------------------------
-- 3. employee_number_conflicts: 사번 held by more than one person today.
CREATE TABLE employee_number_conflicts (
    org_id          UUID        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    employee_number TEXT        NOT NULL CHECK (btrim(employee_number) <> ''),
    employee_ids    UUID[]      NOT NULL CHECK (cardinality(employee_ids) >= 2),
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ NULL,
    resolved_by     UUID        NULL,
    PRIMARY KEY (org_id, employee_number),
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
    FOREIGN KEY (resolved_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
ALTER TABLE employee_number_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_number_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_number_conflicts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT ON employee_number_conflicts TO console_rt;
GRANT UPDATE (resolved_at, resolved_by) ON employee_number_conflicts TO console_rt;

COMMENT ON TABLE employee_number_conflicts IS 'BW-10 5: 사번 shared by several people, resolved through BW-17 before the unique index';
COMMENT ON COLUMN employee_number_conflicts.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN employee_number_conflicts.employee_number IS 'pd:personal — 중복된 사번 (근기법 시행령 §27 식별 정보)';
COMMENT ON COLUMN employee_number_conflicts.employee_ids IS 'pd:personal — 같은 사번을 가진 직원 id들';
COMMENT ON COLUMN employee_number_conflicts.detected_at IS 'pd:none — when the listing found it';
COMMENT ON COLUMN employee_number_conflicts.resolved_at IS 'pd:none — when BW-17 resolved it';
COMMENT ON COLUMN employee_number_conflicts.resolved_by IS 'pd:personal — 해소한 사용자 id';

-- The listing runs as the migration owner (RLS does not apply to it).
INSERT INTO employee_number_conflicts (org_id, employee_number, employee_ids)
SELECT org_id, employee_number, array_agg(id ORDER BY created_at, id)
  FROM employees
 WHERE employee_number IS NOT NULL AND btrim(employee_number) <> ''
   AND merged_into_employee_id IS NULL
 GROUP BY org_id, employee_number
HAVING count(*) > 1;

-- ---------------------------------------------------------------------------
-- 4. leave_api.apply_employee_import_batch v2.
--
-- p_rows is the plan the HR adapter computed and digest-checked inside its own
-- transaction; every item names a CANDIDATE row of this run (`source_key`) and
-- one action, and that row's `name`:
--   insert: {action, source_key, employee_number, name, company, status
--            (ACTIVE|PRE_HIRE|EXITED), hire_date, exit_date, birth_date,
--            org_unit, org_unit_id, job, position, worksite_name,
--            worksite_address, metadata}
--   update: {action, source_key, name, employee_id, employee_number,
--            expected_updated_at, set: {job|position|worksite_name|
--            worksite_address|birth_date: value}}
-- Raw cells, source metadata and leave figures come from the stored row, never
-- from the item. A person whose head moved since the plan, or a 사번 taken
-- since, raises `employee_import_batch.rows_changed` (DETAIL: source_key) and
-- the whole statement rolls back. p_apply_audit must carry the run's
-- `dry_run_digest`. The legacy one-shot import (p_run_id NULL) is gone.
CREATE OR REPLACE FUNCTION leave_api.apply_employee_import_batch(
    p_org_id UUID, p_run_id UUID, p_source_ref TEXT, p_rows JSONB,
    p_actor UUID, p_apply_audit JSONB, p_trace_id TEXT, p_span_id TEXT
) RETURNS TABLE(report JSONB, replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
    v_run public.data_import_runs%ROWTYPE;
    v_src public.data_import_rows%ROWTYPE;
    v_employee public.employees%ROWTYPE;
    v_row JSONB;
    v_set JSONB;
    v_key TEXT;
    v_employee_id UUID;
    v_updated_at TIMESTAMPTZ;
    v_balance RECORD;
    v_outcomes JSONB := '[]'::JSONB;
    v_report JSONB;
BEGIN
    PERFORM leave_api.assert_context(p_org_id,p_actor,p_trace_id,p_span_id);
    PERFORM leave_api.assert_employee_importer(p_org_id,p_actor);
    IF p_run_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.run_required';
    END IF;
    IF p_source_ref IS DISTINCT FROM 'run:' || p_run_id::TEXT
       OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.invalid_payload';
    END IF;
    SELECT * INTO v_run FROM public.data_import_runs r
     WHERE r.org_id=p_org_id AND r.id=p_run_id FOR UPDATE;
    IF NOT FOUND OR v_run.entity_type <> 'employee_hr' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='employee_import_batch.run_not_found';
    END IF;
    IF v_run.status = 'APPLIED' THEN
        RETURN QUERY SELECT v_run.apply_summary, true;
        RETURN;
    END IF;
    IF v_run.status <> 'DRY_RUN' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.run_not_dry_run';
    END IF;
    -- Every item is a CANDIDATE row of this run and carries that row's own
    -- name and raw cells (when it sends them): a forged item changes nothing.
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_rows) item
         WHERE NOT EXISTS (
            SELECT 1 FROM public.data_import_rows ir
             WHERE ir.org_id=p_org_id AND ir.run_id=p_run_id
               AND ir.row_status='CANDIDATE' AND ir.source_key=item->>'source_key'
               AND ir.canonical_row->>'name' IS NOT DISTINCT FROM item->>'name'
               AND (NOT item ? 'raw_row' OR item->'raw_row' = ir.raw_row)
         )
    ) OR (SELECT count(DISTINCT item->>'source_key') FROM jsonb_array_elements(p_rows) item)
         <> jsonb_array_length(p_rows) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.run_payload_mismatch';
    END IF;
    IF v_run.dry_run_digest IS NULL
       OR p_apply_audit->>'dry_run_digest' IS DISTINCT FROM v_run.dry_run_digest THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.digest_mismatch';
    END IF;

    FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
    LOOP
        v_key := v_row->>'source_key';
        SELECT * INTO v_src FROM public.data_import_rows ir
         WHERE ir.org_id=p_org_id AND ir.run_id=p_run_id
           AND ir.row_status='CANDIDATE' AND ir.source_key=v_key;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.run_payload_mismatch';
        END IF;
        IF v_row->>'action' = 'insert' THEN
            IF EXISTS (SELECT 1 FROM public.employees e
                        WHERE e.org_id=p_org_id AND e.employee_number=v_row->>'employee_number') THEN
                RAISE EXCEPTION USING ERRCODE='P0001',
                    MESSAGE='employee_import_batch.rows_changed', DETAIL=v_key;
            END IF;
            INSERT INTO public.employees (
                org_id,company,name,source_filename,source_sheet,source_row,
                source_key,raw_row,source_metadata,employee_number,org_unit,org_unit_id,
                job,position,worksite_name,worksite_address,hire_date,exit_date,
                birth_date,employment_status,identity_resolution_strategy,
                identity_resolution_confidence,identity_review_required,
                identity_name_only_merge
            ) VALUES (
                p_org_id,v_row->>'company',v_row->>'name',
                v_src.canonical_row->>'source_filename',v_src.source_sheet,v_src.source_row,
                -- One person per run row: a later upload of the same file never
                -- collides with (or swaps into) this row by position.
                'run:' || p_run_id::TEXT || '|' || v_key,
                v_src.raw_row,
                coalesce(v_src.canonical_row->'source_metadata','{}'::JSONB)
                    || coalesce(v_row->'metadata','{}'::JSONB),
                v_row->>'employee_number',v_row->>'org_unit',(v_row->>'org_unit_id')::UUID,
                v_row->>'job',v_row->>'position',v_row->>'worksite_name',
                v_row->>'worksite_address',v_row->>'hire_date',v_row->>'exit_date',
                (v_row->>'birth_date')::DATE,v_row->>'status','employee_number','high',
                false,false
            )
            RETURNING id,updated_at INTO v_employee_id,v_updated_at;
            SELECT * INTO v_balance
              FROM leave_api.import_employee_leave_balance(
                p_org_id,v_employee_id,v_updated_at,
                v_src.canonical_row#>>'{canonical,leave_accrued}',
                v_src.canonical_row#>>'{canonical,leave_used}',
                v_src.canonical_row#>>'{canonical,leave_remaining}',
                'employee_import',p_source_ref,
                'employee-import:' || pg_catalog.encode(
                    public.digest(p_source_ref || ':' || v_key,'sha256'),'hex'),
                p_actor,p_trace_id,p_span_id
              );
            INSERT INTO public.import_run_row_snapshots
                (org_id,run_id,employee_id,source_key,outcome,before)
            VALUES (p_org_id,p_run_id,v_employee_id,v_key,'INSERTED',NULL);
        ELSIF v_row->>'action' = 'update' THEN
            SELECT * INTO v_employee FROM public.employees e
             WHERE e.org_id=p_org_id AND e.id=(v_row->>'employee_id')::UUID FOR UPDATE;
            IF NOT FOUND
               OR v_employee.updated_at IS DISTINCT FROM (v_row->>'expected_updated_at')::TIMESTAMPTZ
               OR v_employee.employee_number IS DISTINCT FROM v_row->>'employee_number' THEN
                RAISE EXCEPTION USING ERRCODE='P0001',
                    MESSAGE='employee_import_batch.rows_changed', DETAIL=v_key;
            END IF;
            v_set := coalesce(v_row->'set','{}'::JSONB);
            IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_set) k
                        WHERE k NOT IN ('job','position','worksite_name','worksite_address','birth_date'))
               OR (v_set ? 'birth_date' AND v_employee.birth_date IS NOT NULL) THEN
                RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.invalid_row';
            END IF;
            INSERT INTO public.import_run_row_snapshots
                (org_id,run_id,employee_id,source_key,outcome,before)
            VALUES (p_org_id,p_run_id,v_employee.id,v_key,'UPDATED',
                pg_catalog.jsonb_build_object(
                    'job',v_employee.job,'position',v_employee.position,
                    'worksite_name',v_employee.worksite_name,
                    'worksite_address',v_employee.worksite_address,
                    'birth_date',v_employee.birth_date));
            UPDATE public.employees e SET
                job=CASE WHEN v_set ? 'job' THEN v_set->>'job' ELSE e.job END,
                position=CASE WHEN v_set ? 'position' THEN v_set->>'position' ELSE e.position END,
                worksite_name=CASE WHEN v_set ? 'worksite_name'
                    THEN v_set->>'worksite_name' ELSE e.worksite_name END,
                worksite_address=CASE WHEN v_set ? 'worksite_address'
                    THEN v_set->>'worksite_address' ELSE e.worksite_address END,
                birth_date=CASE WHEN v_set ? 'birth_date'
                    THEN (v_set->>'birth_date')::DATE ELSE e.birth_date END,
                updated_at=pg_catalog.clock_timestamp()
             WHERE e.org_id=p_org_id AND e.id=v_employee.id;
        ELSE
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.invalid_row';
        END IF;
        v_outcomes := v_outcomes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'company',coalesce(v_row->>'company',v_src.canonical_row->>'company'),
            'outcome',CASE v_row->>'action' WHEN 'insert' THEN 'inserted' ELSE 'updated' END));
    END LOOP;

    SELECT pg_catalog.jsonb_build_object(
        'input_rows',v_run.candidate_rows,
        'inserted',(SELECT count(*) FROM jsonb_array_elements(v_outcomes) i
                    WHERE i->>'outcome'='inserted'),
        'updated',(SELECT count(*) FROM jsonb_array_elements(v_outcomes) i
                   WHERE i->>'outcome'='updated'),
        'skipped',v_run.candidate_rows - jsonb_array_length(v_outcomes),
        'companies',coalesce((
            SELECT jsonb_agg(pg_catalog.jsonb_build_object(
                'company',company,'input_rows',input_rows,
                'inserted',inserted,'updated',updated,'skipped',0
            ) ORDER BY company)
            FROM (
                SELECT i->>'company' AS company,count(*) AS input_rows,
                    count(*) FILTER (WHERE i->>'outcome'='inserted') AS inserted,
                    count(*) FILTER (WHERE i->>'outcome'='updated') AS updated
                FROM jsonb_array_elements(v_outcomes) i
                GROUP BY i->>'company'
            ) companies
        ),'[]'::JSONB)
    ) INTO v_report;

    UPDATE public.data_import_runs r
       SET status='APPLIED',apply_summary=v_report,applied_by=p_actor,
           applied_at=pg_catalog.clock_timestamp(),updated_at=pg_catalog.clock_timestamp()
     WHERE r.org_id=p_org_id AND r.id=p_run_id;
    INSERT INTO public.audit_events
        (actor,action,target_type,target_id,before_snap,after_snap,
         trace_id,span_id,occurred_at,org_id)
    VALUES (
        p_actor,'data_import.apply','data_import_run',p_run_id::TEXT,NULL,
        coalesce(p_apply_audit,'{}'::JSONB) || pg_catalog.jsonb_build_object(
            'run_id',p_run_id,'entity_type','employee_hr',
            'source_ref',pg_catalog.btrim(p_source_ref),'report',v_report
        ),p_trace_id,p_span_id,pg_catalog.statement_timestamp(),p_org_id
    );
    RETURN QUERY SELECT v_report,false;
END;
$$;
ALTER FUNCTION leave_api.apply_employee_import_batch(
    UUID, UUID, TEXT, JSONB, UUID, JSONB, TEXT, TEXT
) OWNER TO console_leave_definer;

-- ---------------------------------------------------------------------------
-- 5. BW-19 재입사: the new period's contract window.
GRANT UPDATE (contract_start_date) ON employee_employment_profiles TO console_rt;

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Persist id_type during employee import batch inserts and staged identities, and guard NOT_ISSUED status.
SET LOCAL lock_timeout = '2s';

ALTER TABLE data_import_row_identities
    ADD COLUMN id_type TEXT CHECK (id_type IS NULL OR (id_type IN ('RRN', 'ARC', 'DOMESTIC_RESIDENCE')));

COMMENT ON COLUMN data_import_row_identities.id_type IS 'pd:none — staged employee identity document type';

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
    v_id_type TEXT;
    v_key TEXT;
    v_employee_id UUID;
    v_updated_at TIMESTAMPTZ;
    v_balance RECORD;
    v_outcomes JSONB := '[]'::JSONB;
    v_report JSONB;
BEGIN
    PERFORM leave_api.assert_context(p_org_id,p_actor,p_trace_id,p_span_id);
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
            v_id_type := NULLIF(pg_catalog.btrim(v_row->>'id_type'), '');
            IF v_id_type = 'NOT_ISSUED' AND (v_row->>'status') IS DISTINCT FROM 'PRE_HIRE' THEN
                RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='employee_import_batch.invalid_row';
            END IF;
            INSERT INTO public.employees (
                org_id,company,name,source_filename,source_sheet,source_row,
                source_key,raw_row,source_metadata,employee_number,org_unit,org_unit_id,
                job,position,worksite_name,worksite_address,hire_date,exit_date,
                birth_date,employment_status,id_type,identity_resolution_strategy,
                identity_resolution_confidence,identity_review_required,
                identity_name_only_merge
            ) VALUES (
                p_org_id,v_row->>'company',v_row->>'name',
                v_src.canonical_row->>'source_filename',v_src.source_sheet,v_src.source_row,
                'run:' || p_run_id::TEXT || '|' || v_key,
                v_src.raw_row,
                coalesce(v_src.canonical_row->'source_metadata','{}'::JSONB)
                    || coalesce(v_row->'metadata','{}'::JSONB),
                v_row->>'employee_number',v_row->>'org_unit',(v_row->>'org_unit_id')::UUID,
                v_row->>'job',v_row->>'position',v_row->>'worksite_name',
                v_row->>'worksite_address',v_row->>'hire_date',v_row->>'exit_date',
                (v_row->>'birth_date')::DATE,v_row->>'status',v_id_type,'employee_number','high',
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

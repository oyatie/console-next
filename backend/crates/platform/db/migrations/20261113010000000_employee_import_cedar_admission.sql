-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Cedar admits imports before the command pool mints the one-use capability.
-- The runtime wrapper spends it; trusted command callers retain their existing ACLs.
-- Leaf writers validate context and data without a second role-based permission matrix.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION leave_api.import_employee_leave_balance(
    p_org_id UUID, p_employee_id UUID, p_expected_updated_at TIMESTAMPTZ,
    p_leave_accrued TEXT, p_leave_used TEXT, p_leave_remaining TEXT,
    p_source_kind TEXT, p_source_ref TEXT, p_idempotency_key TEXT,
    p_actor UUID, p_trace_id TEXT, p_span_id TEXT
) RETURNS TABLE(employee_id UUID, updated_at TIMESTAMPTZ, changed BOOLEAN, replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
    v_old_accrued NUMERIC(16,6);
    v_old_used NUMERIC(16,6);
    v_old_remaining NUMERIC(16,6);
    v_old_updated TIMESTAMPTZ;
    v_new_accrued NUMERIC(16,6);
    v_new_used NUMERIC(16,6);
    v_new_remaining NUMERIC(16,6);
    v_new_updated TIMESTAMPTZ;
    v_payload JSONB;
    v_digest TEXT;
    v_receipt public.leave_balance_import_receipts%ROWTYPE;
    v_changed BOOLEAN;
BEGIN
    PERFORM leave_api.assert_context(p_org_id,p_actor,p_trace_id,p_span_id);
    IF p_source_kind <> 'employee_import'
       OR char_length(pg_catalog.btrim(p_source_ref)) NOT BETWEEN 1 AND 256
       OR char_length(pg_catalog.btrim(p_idempotency_key)) NOT BETWEEN 16 AND 256 THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='leave_balance_import.invalid_source';
    END IF;
    IF (p_leave_accrued IS NOT NULL AND p_leave_accrued !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$')
       OR (p_leave_used IS NOT NULL AND p_leave_used !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$')
       OR (p_leave_remaining IS NOT NULL AND p_leave_remaining !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$') THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='leave_balance_import.invalid_amount';
    END IF;
    BEGIN
        v_new_accrued := p_leave_accrued::NUMERIC(16,6);
        v_new_used := p_leave_used::NUMERIC(16,6);
        v_new_remaining := p_leave_remaining::NUMERIC(16,6);
    EXCEPTION WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='leave_balance_import.amount_out_of_range';
    END;
    v_payload := pg_catalog.jsonb_build_object(
        'employee_id',p_employee_id,
        'leave_accrued',CASE WHEN v_new_accrued IS NULL THEN NULL ELSE v_new_accrued::TEXT END,
        'leave_used',CASE WHEN v_new_used IS NULL THEN NULL ELSE v_new_used::TEXT END,
        'leave_remaining',CASE WHEN v_new_remaining IS NULL THEN NULL ELSE v_new_remaining::TEXT END,
        'source_kind',p_source_kind,'source_ref',pg_catalog.btrim(p_source_ref)
    );
    v_digest := pg_catalog.encode(public.digest(v_payload::TEXT,'sha256'),'hex');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_org_id::TEXT || ':' || p_idempotency_key, 166)
    );
    SELECT * INTO v_receipt FROM public.leave_balance_import_receipts r
     WHERE r.org_id=p_org_id AND r.idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF v_receipt.employee_id IS DISTINCT FROM p_employee_id
           OR v_receipt.payload_digest IS DISTINCT FROM v_digest THEN
            RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='leave_balance_import.idempotency_conflict';
        END IF;
        RETURN QUERY SELECT p_employee_id,v_receipt.result_updated_at,v_receipt.changed,true;
        RETURN;
    END IF;
    SELECT e.leave_accrued,e.leave_used,e.leave_remaining,e.updated_at
      INTO v_old_accrued,v_old_used,v_old_remaining,v_old_updated
      FROM public.employees e WHERE e.org_id=p_org_id AND e.id=p_employee_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='leave_balance_import.employee_not_found';
    END IF;
    IF v_old_updated IS DISTINCT FROM p_expected_updated_at THEN
        RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='leave_balance_import.concurrent_modification';
    END IF;
    v_changed := v_old_accrued IS DISTINCT FROM v_new_accrued
        OR v_old_used IS DISTINCT FROM v_new_used
        OR v_old_remaining IS DISTINCT FROM v_new_remaining;
    IF v_changed THEN
        UPDATE public.employees e
           SET leave_accrued=v_new_accrued,leave_used=v_new_used,
               leave_remaining=v_new_remaining,updated_at=pg_catalog.clock_timestamp()
         WHERE e.org_id=p_org_id AND e.id=p_employee_id
         RETURNING e.updated_at INTO v_new_updated;
        INSERT INTO public.audit_events
            (actor,action,target_type,target_id,branch_id,before_snap,after_snap,
             trace_id,span_id,occurred_at,org_id)
        VALUES
            (p_actor,'employee.leave_balance_import','employee',p_employee_id::TEXT,NULL,
             pg_catalog.jsonb_build_object(
                 'leave_accrued',v_old_accrued::TEXT,'leave_used',v_old_used::TEXT,
                 'leave_remaining',v_old_remaining::TEXT,'updated_at',v_old_updated),
             v_payload || pg_catalog.jsonb_build_object('updated_at',v_new_updated,
                 'idempotency_key',p_idempotency_key),
             p_trace_id,p_span_id,pg_catalog.statement_timestamp(),p_org_id);
    ELSE
        v_new_updated := v_old_updated;
    END IF;
    INSERT INTO public.leave_balance_import_receipts
        (org_id,employee_id,source_kind,source_ref,idempotency_key,payload_digest,
         result_updated_at,changed,actor,trace_id,span_id)
    VALUES
        (p_org_id,p_employee_id,p_source_kind,pg_catalog.btrim(p_source_ref),p_idempotency_key,
         v_digest,v_new_updated,v_changed,p_actor,p_trace_id,p_span_id);
    RETURN QUERY SELECT p_employee_id,v_new_updated,v_changed,false;
END;
$$;

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

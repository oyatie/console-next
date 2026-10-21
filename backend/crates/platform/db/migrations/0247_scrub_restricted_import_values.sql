-- BW-26: spreadsheet imports stored every column, restricted ones included
-- (주민등록번호, 급여, 계좌, 전화 ...), in data_import_rows.raw_row and
-- employees.raw_row; only the preview was masked. The importer now drops those
-- cells and any 주민등록번호-shaped value before persisting
-- (hr.rs persistable_import_row). This scrubs what is already stored. UPDATE
-- only: no row is inserted or deleted.
--
-- The fragment lists mirror hr.rs is_restricted_employee_import_header and
-- is_restricted_attendance_import_header at this commit; no canonical import
-- target alias contains one of them, so matching the key alone is the same
-- rule. The RRN rule mirrors hr.rs contains_rrn_shaped: \d{6}-?[1-8]\d{6} not
-- touching another digit.
--
-- An employee row keeps the NAMES of the non-empty cells it loses in
-- canonical_row.source_metadata.dropped_restricted_columns, which the payroll
-- roster reads in place of the values (payroll/adapter-postgres roster.rs).
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION public.bw26_is_rrn(v JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(v) IN ('string', 'number')
       AND (v #>> '{}') ~ '(^|[^0-9])[0-9]{6}-?[1-8][0-9]{6}([^0-9]|$)'
$$;

CREATE FUNCTION public.bw26_is_restricted_key(k TEXT, fragments TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT EXISTS (SELECT 1 FROM unnest(fragments) f WHERE strpos(k, f) > 0)
$$;

-- Drops restricted keys and RRN-shaped scalars at any depth.
CREATE FUNCTION public.bw26_scrub(j JSONB, fragments TEXT[]) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF jsonb_typeof(j) = 'object' THEN
        RETURN COALESCE((
            SELECT jsonb_object_agg(e.key, public.bw26_scrub(e.value, fragments))
              FROM jsonb_each(j) e
             WHERE NOT public.bw26_is_restricted_key(e.key, fragments)
               AND NOT public.bw26_is_rrn(e.value)
        ), '{}'::JSONB);
    ELSIF jsonb_typeof(j) = 'array' THEN
        RETURN COALESCE((
            SELECT jsonb_agg(public.bw26_scrub(e.value, fragments) ORDER BY e.ord)
              FROM jsonb_array_elements(j) WITH ORDINALITY e(value, ord)
             WHERE NOT public.bw26_is_rrn(e.value)
        ), '[]'::JSONB);
    END IF;
    RETURN j;
END;
$$;

-- Names of the non-empty top-level cells bw26_scrub removes from a raw row.
CREATE FUNCTION public.bw26_dropped(raw JSONB, fragments TEXT[]) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(jsonb_agg(e.key ORDER BY e.key), '[]'::JSONB)
      FROM jsonb_each(CASE WHEN jsonb_typeof(raw) = 'object' THEN raw ELSE '{}'::JSONB END) e
     WHERE (public.bw26_is_restricted_key(e.key, fragments) OR public.bw26_is_rrn(e.value))
       AND (jsonb_typeof(e.value) IN ('number', 'boolean')
            OR (jsonb_typeof(e.value) = 'string' AND btrim(e.value #>> '{}') <> ''))
$$;

CREATE FUNCTION public.bw26_fragments(entity_type TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE entity_type
        WHEN 'attendance_direct' THEN ARRAY[
            '주민', '급여', '시급', '수당', '보험', '소득세', '은행', '계좌', '전화',
            '연락처', '휴대폰', '주소', '개인'
        ]
        ELSE ARRAY[
            '주민', '급여', '시급', '통상', '수당', '국민연금', '건강보험', '고용보험',
            '산재', '소득세', '은행', '계좌', '장애', '퇴직금', '지급일', '급여산정',
            '휴대폰', '전화', '연락처', '개인주소', '거주주소'
        ]
    END
$$;

-- data_import_rows is append-only for the runtime (0070); this one-time
-- privacy scrub is the sanctioned exception.
ALTER TABLE data_import_rows DISABLE TRIGGER trg_data_import_rows_no_update;

UPDATE data_import_rows r
   SET raw_row = public.bw26_scrub(r.raw_row, public.bw26_fragments(run.entity_type)),
       canonical_row = CASE
           WHEN run.entity_type = 'employee_hr'
            AND jsonb_typeof(r.canonical_row -> 'source_metadata') = 'object'
            AND public.bw26_dropped(r.raw_row, public.bw26_fragments(run.entity_type)) <> '[]'::JSONB
           THEN jsonb_set(
               public.bw26_scrub(r.canonical_row, '{}'),
               '{source_metadata,dropped_restricted_columns}',
               public.bw26_dropped(r.raw_row, public.bw26_fragments(run.entity_type))
           )
           ELSE public.bw26_scrub(r.canonical_row, '{}')
       END
  FROM data_import_runs run
 WHERE run.id = r.run_id
   AND run.org_id = r.org_id
   AND (r.raw_row IS DISTINCT FROM public.bw26_scrub(r.raw_row, public.bw26_fragments(run.entity_type))
        OR r.canonical_row IS DISTINCT FROM public.bw26_scrub(r.canonical_row, '{}'));

ALTER TABLE data_import_rows ENABLE TRIGGER trg_data_import_rows_no_update;

-- employees.updated_at is the optimistic-concurrency token; a scrub is not an
-- edit, so it is left alone.
UPDATE employees e
   SET raw_row = public.bw26_scrub(e.raw_row, public.bw26_fragments('employee_hr')),
       source_metadata = public.bw26_scrub(e.source_metadata, '{}')
 WHERE e.raw_row IS DISTINCT FROM public.bw26_scrub(e.raw_row, public.bw26_fragments('employee_hr'))
    OR e.source_metadata IS DISTINCT FROM public.bw26_scrub(e.source_metadata, '{}');

DROP FUNCTION public.bw26_fragments(TEXT);
DROP FUNCTION public.bw26_dropped(JSONB, TEXT[]);
DROP FUNCTION public.bw26_scrub(JSONB, TEXT[]);
DROP FUNCTION public.bw26_is_restricted_key(TEXT, TEXT[]);
DROP FUNCTION public.bw26_is_rrn(JSONB);

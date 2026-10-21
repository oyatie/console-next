-- PII-2 (0249): scrub what 0247 missed. 0247 removed restricted cells and
-- \d{6}-?[1-8]\d{6} values from data_import_rows.raw_row/canonical_row and
-- employees.raw_row/source_metadata. Still stored under the be8e38d rules:
--   * RRN-shaped header KEYS (form-layout sheets) and 핸드폰 keys;
--   * stripped-zero RRNs: a whole 11–12 digit number (optional .0) that is a
--     2000–2009 birth date plus a 3/4/7/8 gender digit once Excel's dropped
--     leading zeros are restored (hr/import_pii.rs is_stripped_zero_rrn);
--   * the PII-2 headers (hr/import_pii.rs is_pii2_restricted_header): English
--     ssn/rrn/phone/mobile/salary/wage/account/bank (any case), 생년월일, and a
--     bare 주소 key (home address; it was a worksite_address alias until now,
--     so employees/canonical worksite_address copied from it is cleared too);
--   * RRNs outside the JSON 0247 read: run/row/employee lineage text (file and
--     sheet names, source keys), employees.name/company/employee_number,
--     attendance_direct_import_events names and numbers, and the run
--     mapping_profile/dry_run_summary/apply_summary (company names come from
--     sheet names, which were not checked before be8e38d).
-- UPDATE only: no row is inserted or deleted.
--
-- JSON: a restricted or RRN-shaped key and an RRN-shaped scalar are dropped at
-- any depth (0247's rule). TEXT (NOT NULL lineage columns, joined across tables
-- by source_key): each RRN is replaced with 'rrn-' + 12 hex of
-- md5(salt || rrn). The salt is random, transaction-local and never stored, so
-- the token is the same in every table but cannot be reversed.
--
-- Audit rows are never edited here (owner decision): import audit snapshots
-- are only counted in a NOTICE at the end. The full read-only scan is
-- drafts/specs/pii2_audit_scan.sql; any redaction follows
-- drafts/specs/pii2_audit_redaction.md and needs privacy counsel first.
SET LOCAL lock_timeout = '2s';
DO $$ BEGIN PERFORM pg_catalog.set_config('pii2.salt', gen_random_uuid()::TEXT, true); END $$;

-- d: 13 digits with the stripped zeros restored. A 2000–2009 birth date and
-- a 3/4/7/8 gender digit (CASE keeps the casts behind their guards).
CREATE FUNCTION public.pii2_is_2000s_rrn(d TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT substr(d, 7, 1) IN ('3', '4', '7', '8')
       AND CASE WHEN substr(d, 3, 2)::INT BETWEEN 1 AND 12
           THEN substr(d, 5, 2)::INT BETWEEN 1 AND extract(DAY FROM
                make_date(2000 + substr(d, 1, 2)::INT, substr(d, 3, 2)::INT, 1)
                + INTERVAL '1 month - 1 day')::INT
           ELSE false END
$$;

-- 0247's \d{6}-?[1-8]\d{6} not touching a digit, or a stripped-zero RRN.
CREATE FUNCTION public.pii2_is_rrn_text(t TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT t ~ '(^|[^0-9])[0-9]{6}-?[1-8][0-9]{6}([^0-9]|$)'
        OR CASE WHEN regexp_replace(t, '\.0$', '') ~ '^[1-9][0-9]{10,11}$'
           THEN public.pii2_is_2000s_rrn(lpad(regexp_replace(t, '\.0$', ''), 13, '0'))
           ELSE false END
$$;

-- A hex digest (source_sha256 in audit snapshots) often holds 13 digits in a
-- row; it is never personal data, so it is not an RRN.
CREATE FUNCTION public.pii2_is_rrn(v JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(v) IN ('string', 'number')
       AND (v #>> '{}') !~ '^[0-9a-f]{32,}$'
       AND public.pii2_is_rrn_text(v #>> '{}')
$$;

-- fragments match anywhere in lower(key); exact keys match whole.
CREATE FUNCTION public.pii2_is_restricted_key(k TEXT, fragments TEXT[], exact TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT public.pii2_is_rrn_text(k)
        OR k = ANY (exact)
        OR EXISTS (SELECT 1 FROM unnest(fragments) f WHERE strpos(lower(k), f) > 0)
$$;

CREATE FUNCTION public.pii2_scrub(j JSONB, fragments TEXT[], exact TEXT[]) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF jsonb_typeof(j) = 'object' THEN
        RETURN COALESCE((
            SELECT jsonb_object_agg(e.key, public.pii2_scrub(e.value, fragments, exact))
              FROM jsonb_each(j) e
             WHERE NOT public.pii2_is_restricted_key(e.key, fragments, exact)
               AND NOT public.pii2_is_rrn(e.value)
        ), '{}'::JSONB);
    ELSIF jsonb_typeof(j) = 'array' THEN
        RETURN COALESCE((
            SELECT jsonb_agg(public.pii2_scrub(e.value, fragments, exact) ORDER BY e.ord)
              FROM jsonb_array_elements(j) WITH ORDINALITY e(value, ord)
             WHERE NOT public.pii2_is_rrn(e.value)
        ), '[]'::JSONB);
    END IF;
    RETURN j;
END;
$$;

-- Lineage-only JSON (no spreadsheet header keys): RRNs only.
CREATE FUNCTION public.pii2_scrub_rrn(j JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$ SELECT public.pii2_scrub(j, '{}', '{}') $$;

CREATE FUNCTION public.pii2_mask(t TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
    m TEXT;
    tok TEXT;
BEGIN
    IF t IS NULL OR NOT public.pii2_is_rrn_text(t) THEN
        RETURN t;
    END IF;
    IF regexp_replace(t, '\.0$', '') ~ '^[1-9][0-9]{10,11}$' THEN
        m := lpad(regexp_replace(t, '\.0$', ''), 13, '0');
        RETURN 'rrn-' || left(md5(current_setting('pii2.salt') || m), 12);
    END IF;
    LOOP
        m := (regexp_match(t, '(^|[^0-9])([0-9]{6}-?[1-8][0-9]{6})([^0-9]|$)'))[2];
        EXIT WHEN m IS NULL;
        tok := 'rrn-' || left(md5(current_setting('pii2.salt') || replace(m, '-', '')), 12);
        t := replace(t, m, tok);
    END LOOP;
    RETURN t;
END;
$$;

CREATE FUNCTION public.pii2_fragments(entity_type TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE entity_type
        WHEN 'attendance_direct' THEN ARRAY[
            '주민', '급여', '시급', '수당', '보험', '소득세', '은행', '계좌', '전화',
            '연락처', '휴대폰', '핸드폰', '주소', '개인'
        ]
        ELSE ARRAY[
            '주민', '급여', '시급', '통상', '수당', '국민연금', '건강보험', '고용보험',
            '산재', '소득세', '은행', '계좌', '장애', '퇴직금', '지급일', '급여산정',
            '휴대폰', '핸드폰', '전화', '연락처', '개인주소', '거주주소'
        ]
    END || ARRAY[
        '생년월일', 'ssn', 'rrn', 'phone', 'mobile', 'salary', 'wage', 'account', 'bank'
    ]
$$;

-- data_import_rows is append-only for the runtime (0070); 0247 set the precedent.
ALTER TABLE data_import_rows DISABLE TRIGGER trg_data_import_rows_no_update;

UPDATE data_import_rows r
   SET raw_row = public.pii2_scrub(r.raw_row, public.pii2_fragments(run.entity_type), '{주소}'),
       canonical_row = public.pii2_scrub_rrn(
           CASE WHEN r.raw_row ? '주소'
                 AND r.canonical_row #>> '{canonical,worksite_address}' = r.raw_row ->> '주소'
                THEN jsonb_set(r.canonical_row, '{canonical,worksite_address}', 'null')
                ELSE r.canonical_row END),
       source_sheet = public.pii2_mask(r.source_sheet),
       source_key = public.pii2_mask(r.source_key)
  FROM data_import_runs run
 WHERE run.id = r.run_id
   AND run.org_id = r.org_id
   AND (r.raw_row IS DISTINCT FROM
            public.pii2_scrub(r.raw_row, public.pii2_fragments(run.entity_type), '{주소}')
        OR r.canonical_row IS DISTINCT FROM public.pii2_scrub_rrn(r.canonical_row)
        OR public.pii2_is_rrn_text(r.source_sheet)
        OR public.pii2_is_rrn_text(r.source_key));

ALTER TABLE data_import_rows ENABLE TRIGGER trg_data_import_rows_no_update;

-- apply_summary is command-owned (0166 writer guard); this scrub changes no
-- status, actor or timestamp, so the guard is paused for it alone.
ALTER TABLE data_import_runs DISABLE TRIGGER trg_data_import_runs_employee_hr_command_only;

UPDATE data_import_runs run
   SET source_filename = public.pii2_mask(run.source_filename),
       mapping_profile = public.pii2_scrub_rrn(run.mapping_profile),
       dry_run_summary = public.pii2_scrub_rrn(run.dry_run_summary),
       apply_summary = public.pii2_scrub_rrn(run.apply_summary)
 WHERE public.pii2_is_rrn_text(run.source_filename)
    OR run.mapping_profile IS DISTINCT FROM public.pii2_scrub_rrn(run.mapping_profile)
    OR run.dry_run_summary IS DISTINCT FROM public.pii2_scrub_rrn(run.dry_run_summary)
    OR run.apply_summary IS DISTINCT FROM public.pii2_scrub_rrn(run.apply_summary);

ALTER TABLE data_import_runs ENABLE TRIGGER trg_data_import_runs_employee_hr_command_only;

-- employees.updated_at is the optimistic-concurrency token; a scrub is not an
-- edit, so it is left alone (as in 0247).
UPDATE employees e
   SET raw_row = public.pii2_scrub(e.raw_row, public.pii2_fragments('employee_hr'), '{주소}'),
       source_metadata = public.pii2_scrub_rrn(e.source_metadata),
       worksite_address = CASE
           WHEN e.raw_row ? '주소' AND e.worksite_address = e.raw_row ->> '주소' THEN NULL
           ELSE e.worksite_address END,
       name = public.pii2_mask(e.name),
       company = public.pii2_mask(e.company),
       employee_number = public.pii2_mask(e.employee_number),
       source_filename = public.pii2_mask(e.source_filename),
       source_sheet = public.pii2_mask(e.source_sheet),
       source_key = public.pii2_mask(e.source_key)
 WHERE e.raw_row IS DISTINCT FROM
           public.pii2_scrub(e.raw_row, public.pii2_fragments('employee_hr'), '{주소}')
    OR e.source_metadata IS DISTINCT FROM public.pii2_scrub_rrn(e.source_metadata)
    OR public.pii2_is_rrn_text(e.name)
    OR public.pii2_is_rrn_text(e.company)
    OR public.pii2_is_rrn_text(e.employee_number)
    OR public.pii2_is_rrn_text(e.source_filename)
    OR public.pii2_is_rrn_text(e.source_sheet)
    OR public.pii2_is_rrn_text(e.source_key);

ALTER TABLE attendance_direct_import_events
    DISABLE TRIGGER trg_attendance_direct_import_events_no_update;

UPDATE attendance_direct_import_events ev
   SET employee_number = public.pii2_mask(ev.employee_number),
       employee_name = public.pii2_mask(ev.employee_name),
       branch_name = public.pii2_mask(ev.branch_name),
       source_sheet = public.pii2_mask(ev.source_sheet),
       source_key = public.pii2_mask(ev.source_key)
 WHERE public.pii2_is_rrn_text(ev.employee_number)
    OR public.pii2_is_rrn_text(ev.employee_name)
    OR public.pii2_is_rrn_text(ev.branch_name)
    OR public.pii2_is_rrn_text(ev.source_sheet)
    OR public.pii2_is_rrn_text(ev.source_key);

ALTER TABLE attendance_direct_import_events
    ENABLE TRIGGER trg_attendance_direct_import_events_no_update;

-- Import audit snapshots (file names, report.companies[].company) are NOT
-- edited here: ci/gates/migration-safety forbids DISABLE TRIGGER on
-- audit_events, and audit-chain row_hash covers both snaps, so editing a sealed
-- row reads as tampering. They are counted instead (the migration role is
-- BYPASSRLS, so FORCE RLS hides no org); drafts/specs/pii2_audit_scan.sql
-- reports every audit table. A row is sealed when (created_at, id) is at or
-- before a seal end of its org.
DO $$
DECLARE
    sealed BIGINT;
    unsealed BIGINT;
BEGIN
    SELECT count(*) FILTER (WHERE s.hit), count(*) FILTER (WHERE NOT s.hit)
      INTO sealed, unsealed
      FROM (SELECT EXISTS (SELECT 1 FROM audit_chain_seals c
                            WHERE c.org_id = a.org_id
                              AND (a.created_at, a.id) <= (c.to_created_at, c.to_event_id)) AS hit
              FROM audit_events a
             WHERE (a.action LIKE 'data_import.%' OR a.action LIKE 'attendance_import.%'
                    OR a.action LIKE 'employee.import.%')
               AND (a.before_snap IS DISTINCT FROM public.pii2_scrub_rrn(a.before_snap)
                    OR a.after_snap IS DISTINCT FROM public.pii2_scrub_rrn(a.after_snap))) s;
    IF sealed + unsealed > 0 THEN
        RAISE NOTICE 'pii2: % sealed and % unsealed import audit_events rows hold an RRN; owner decision needed',
            sealed, unsealed;
    END IF;
END;
$$;

DROP FUNCTION public.pii2_fragments(TEXT);
DROP FUNCTION public.pii2_mask(TEXT);
DROP FUNCTION public.pii2_scrub_rrn(JSONB);
DROP FUNCTION public.pii2_scrub(JSONB, TEXT[], TEXT[]);
DROP FUNCTION public.pii2_is_restricted_key(TEXT, TEXT[], TEXT[]);
DROP FUNCTION public.pii2_is_rrn(JSONB);
DROP FUNCTION public.pii2_is_rrn_text(TEXT);
DROP FUNCTION public.pii2_is_2000s_rrn(TEXT);

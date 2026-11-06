-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Remove restricted values while preserving import structure.
-- contract-of: 0296
-- migration-backfill: Scrub historical plaintext without restoring it on application rollback.
-- Transactional privacy cleanup preserves row UUIDs and concurrency timestamps.
-- Application rollback keeps the scrubbed values. There is deliberately no
-- plaintext backup or inverse migration that could restore restricted data.
SET LOCAL lock_timeout = '2s';
SELECT set_config('import_scrub.salt', gen_random_uuid()::text, true);

-- Mirrors the import classifier's full-width digits, dashes and Unicode whitespace.
CREATE FUNCTION pg_temp.import_restricted(t text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    n text;
    d text;
    century integer := 2000;
BEGIN
    IF t ~ '^[0-9a-f]{32,}$' THEN RETURN false; END IF;
    n := regexp_replace(translate(translate(t, '０１２３４５６７８９．', '0123456789.'),
        '‐‑‒–—―−﹣－', '---------'),
        U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]', ' ', 'g');
    IF n ~ '(^|[^0-9])[0-9]{6} *-? *[1-8][0-9]{6}([^0-9]|$)' THEN
        RETURN true;
    END IF;
    n := replace(n, ' ', '');
    d := regexp_replace(replace(n, '-', ''), '\.0$', '');
    IF length(n) - length(replace(n, '-', '')) <= 1
       AND d ~ '^[0-9]{6}[1-8][0-9]{6}$' THEN
        century := CASE WHEN substr(d, 7, 1) IN ('1','2','5','6') THEN 1900 ELSE 2000 END;
    ELSIF n ~ '^[1-9][0-9]{10,11}(\.0)?$' THEN
        -- Excel's dropped leading zeros are only restored for a 2000s birth.
        d := lpad(regexp_replace(n, '\.0$', ''), 13, '0');
        IF substr(d, 7, 1) NOT IN ('3','4','7','8') THEN RETURN false; END IF;
    ELSE
        RETURN false;
    END IF;
    IF substr(d, 3, 2)::int NOT BETWEEN 1 AND 12 THEN RETURN false; END IF;
    RETURN substr(d, 5, 2)::int BETWEEN 1 AND extract(DAY FROM
        make_date(century + substr(d, 1, 2)::int, substr(d, 3, 2)::int, 1)
        + interval '1 month - 1 day')::int;
END;
$$;

-- Equal source keys remain equal across tables. Letter-only tokens cannot
-- themselves match the classifier when this cleanup is replayed.
CREATE FUNCTION pg_temp.import_mask(t text) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
    SELECT CASE WHEN pg_temp.import_restricted(t)
        THEN 'redacted-' || translate(md5(current_setting('import_scrub.salt') || t),
                                     '0123456789abcdef', 'ghijklmnopqrstuv')
        ELSE t END
$$;

-- Raw cells are dropped; typed documents keep their keys and scalar types
-- except restricted numbers, which become opaque strings. This preserves
-- lineage and rollback document structure without preserving personal data.
CREATE FUNCTION pg_temp.import_scrub(j jsonb, raw_cells boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN
    IF jsonb_typeof(j) = 'object' THEN
        RETURN COALESCE((SELECT jsonb_object_agg(pg_temp.import_mask(e.key),
            pg_temp.import_scrub(e.value, raw_cells)) FROM jsonb_each(j) e
            WHERE NOT raw_cells OR NOT (pg_temp.import_restricted(e.key)
                OR (jsonb_typeof(e.value) IN ('string','number')
                    AND pg_temp.import_restricted(e.value #>> '{}')))), '{}'::jsonb);
    ELSIF jsonb_typeof(j) = 'array' THEN
        RETURN COALESCE((SELECT jsonb_agg(pg_temp.import_scrub(e.value, raw_cells) ORDER BY e.ord)
            FROM jsonb_array_elements(j) WITH ORDINALITY e(value, ord)
            WHERE NOT raw_cells OR NOT (jsonb_typeof(e.value) IN ('string','number')
                AND pg_temp.import_restricted(e.value #>> '{}'))), '[]'::jsonb);
    ELSIF jsonb_typeof(j) IN ('string','number') AND pg_temp.import_restricted(j #>> '{}') THEN
        RETURN to_jsonb(pg_temp.import_mask(j #>> '{}'));
    END IF;
    RETURN j;
END;
$$;

-- Immutable history is reported for a separate owner decision, never rewritten.
DO $$
DECLARE
    revisions bigint;
    reviews bigint;
BEGIN
    SELECT count(*) INTO revisions FROM person_revisions
     WHERE attributes IS DISTINCT FROM pg_temp.import_scrub(attributes, false)
        OR receipt IS DISTINCT FROM pg_temp.import_scrub(receipt, false);
    SELECT count(*) INTO reviews FROM person_binding_reviews
     WHERE evidence IS DISTINCT FROM pg_temp.import_scrub(evidence, false);
    IF revisions + reviews > 0 THEN
        RAISE NOTICE 'import scrub: % person_revisions and % person_binding_reviews rows hold restricted plaintext; owner decision needed',
            revisions, reviews;
    END IF;
END;
$$;

-- Only these existing import writer guards are paused, inside the migration
-- transaction; audit records and their protections remain untouched.
ALTER TABLE data_import_rows DISABLE TRIGGER trg_data_import_rows_no_update;
ALTER TABLE data_import_runs DISABLE TRIGGER trg_data_import_runs_employee_hr_command_only;
ALTER TABLE attendance_direct_import_events DISABLE TRIGGER trg_attendance_direct_import_events_no_update;

DO $$
DECLARE
    spec record;
    col text;
    sets text;
    predicates text;
    expression text;
BEGIN
    FOR spec IN SELECT * FROM (VALUES
        ('data_import_rows', ARRAY['source_sheet','source_key'],
            ARRAY['canonical_row','validation'], ARRAY['raw_row']),
        ('data_import_runs', ARRAY['source_filename'],
            ARRAY['mapping_profile','dry_run_summary','dry_run_decisions','apply_summary','apply_job','rollback_job'], ARRAY[]::text[]),
        ('employees', ARRAY['name','company','employee_number','org_unit','job','position',
            'worksite_name','worksite_address','source_filename','source_sheet','source_key'],
            ARRAY['source_metadata'], ARRAY['raw_row']),
        ('import_run_row_snapshots', ARRAY['source_key'], ARRAY['before'], ARRAY[]::text[]),
        ('data_import_row_identities', ARRAY['source_key'], ARRAY[]::text[], ARRAY[]::text[]),
        ('data_import_row_phones', ARRAY['source_key'], ARRAY[]::text[], ARRAY[]::text[]),
        ('import_reconcile_checks', ARRAY['source_key'], ARRAY[]::text[], ARRAY[]::text[]),
        ('attendance_direct_import_events', ARRAY['employee_number','employee_name','branch_name','source_sheet','source_key'],
            ARRAY[]::text[], ARRAY[]::text[])
    ) AS s(table_name, texts, documents, cells) LOOP
        sets := ''; predicates := '';
        FOREACH col IN ARRAY spec.texts || spec.documents || spec.cells LOOP
            expression := CASE WHEN col = ANY(spec.texts)
                THEN format('pg_temp.import_mask(%I)', col)
                ELSE format('pg_temp.import_scrub(%I, %L)', col, col = ANY(spec.cells)) END;
            sets := sets || CASE WHEN sets = '' THEN '' ELSE ', ' END || format('%I = %s', col, expression);
            predicates := predicates || CASE WHEN predicates = '' THEN '' ELSE ' OR ' END
                || format('%I IS DISTINCT FROM %s', col, expression);
        END LOOP;
        EXECUTE format('UPDATE public.%I SET %s WHERE %s', spec.table_name, sets, predicates);
    END LOOP;
    -- Run updates queue deferred audit checks even when their status is unchanged.
    SET CONSTRAINTS ALL IMMEDIATE;
END;
$$;

ALTER TABLE data_import_rows ENABLE TRIGGER trg_data_import_rows_no_update;
ALTER TABLE data_import_runs ENABLE TRIGGER trg_data_import_runs_employee_hr_command_only;
ALTER TABLE attendance_direct_import_events ENABLE TRIGGER trg_attendance_direct_import_events_no_update;
DROP FUNCTION pg_temp.import_scrub(jsonb, boolean);
DROP FUNCTION pg_temp.import_mask(text);
DROP FUNCTION pg_temp.import_restricted(text);

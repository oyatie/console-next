-- Expand: immutable knowledge snapshots inherit each source table's RLS.
SET LOCAL lock_timeout = '2s';
DO $$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['legal_entities','business_registrations','workplaces','employee_lifecycle_events','employee_employment_profiles'] LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN asof_history jsonb NOT NULL DEFAULT ''[]''::jsonb CHECK (jsonb_typeof(asof_history) = ''array''), ADD COLUMN asof_history_started_at timestamptz NOT NULL DEFAULT now()', t);
        EXECUTE format('COMMENT ON COLUMN %I.asof_history IS %L', t,
            'pd:personal — immutable knowledge snapshots of source facts; source-table privacy and retention apply, 개보법 제2조제1호나목 결합 식별');
        EXECUTE format('COMMENT ON COLUMN %I.asof_history_started_at IS %L', t, 'pd:none — earliest recoverable header snapshot');
    END LOOP;
END $$;
CREATE FUNCTION record_entity_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value jsonb; previous jsonb; chart_keys text[] := ARRAY[
    'id','org_id','employee_id','event_type','effective_date','created_at','state','voids_event_id',
    'from_status','to_status','from_org_unit_id','to_org_unit_id','from_org_unit','to_org_unit',
    'to_workplace_id','from_employment_type','to_employment_type'];
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.asof_history IS DISTINCT FROM OLD.asof_history OR NEW.asof_history_started_at IS DISTINCT FROM OLD.asof_history_started_at THEN
            RAISE EXCEPTION 'knowledge history is recorded by the database' USING ERRCODE = '23514';
        END IF;
        NEW.asof_history := OLD.asof_history;
    ELSE
        NEW.asof_history := '[]'::jsonb;
        NEW.asof_history_started_at := NEW.created_at;
    END IF;
    value := to_jsonb(NEW) - 'asof_history' - 'asof_history_started_at';
    previous := to_jsonb(OLD) - 'asof_history' - 'asof_history_started_at';
    IF TG_TABLE_NAME = 'employee_lifecycle_events' THEN
        SELECT jsonb_object_agg(key, v) INTO value FROM jsonb_each(value) AS fields(key,v) WHERE key = ANY(chart_keys);
        SELECT jsonb_object_agg(key, v) INTO previous FROM jsonb_each(previous) AS fields(key,v) WHERE key = ANY(chart_keys);
    ELSIF TG_TABLE_NAME = 'employee_employment_profiles' THEN
        SELECT jsonb_object_agg(key, v) INTO value FROM jsonb_each(value) AS fields(key,v) WHERE key = ANY(ARRAY['employee_id','org_id','created_at','employment_type']);
        SELECT jsonb_object_agg(key, v) INTO previous FROM jsonb_each(previous) AS fields(key,v) WHERE key = ANY(ARRAY['employee_id','org_id','created_at','employment_type']);
    END IF;
    IF TG_OP = 'INSERT' OR value IS DISTINCT FROM previous THEN
        NEW.asof_history := NEW.asof_history || jsonb_build_array(jsonb_build_object(
            'at', statement_timestamp(), 'value', value));
    END IF;
    RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['legal_entities','business_registrations','workplaces','employee_lifecycle_events','employee_employment_profiles'] LOOP
        EXECUTE format('CREATE TRIGGER zz_record_knowledge BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION record_entity_knowledge()',t);
    END LOOP;
END $$;
CREATE FUNCTION entity_known_row(value jsonb, known_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN known_at IS NULL THEN value
        WHEN value->'asof_history' = '[]'::jsonb THEN
            CASE WHEN (value->>'asof_history_started_at')::timestamptz <= known_at THEN value END
        ELSE (SELECT h->'value' FROM jsonb_array_elements(value->'asof_history') WITH ORDINALITY AS history(h,n)
              WHERE (h->>'at')::timestamptz <= known_at ORDER BY n DESC LIMIT 1) END
$$;

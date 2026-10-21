-- Expand: retain the tracking-start baseline on the first change to a legacy row.
SET LOCAL lock_timeout = '2s';
CREATE OR REPLACE FUNCTION record_entity_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
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
        -- The migration-start value remains known after a legacy row's first mutation.
        IF TG_OP = 'UPDATE' AND OLD.asof_history = '[]'::jsonb THEN
            NEW.asof_history := jsonb_build_array(jsonb_build_object(
                'at', OLD.asof_history_started_at, 'value', previous));
        END IF;
        NEW.asof_history := NEW.asof_history || jsonb_build_array(jsonb_build_object(
            'at', statement_timestamp(), 'value', value));
    END IF;
    RETURN NEW;
END $$;

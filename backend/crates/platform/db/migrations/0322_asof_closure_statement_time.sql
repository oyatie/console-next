-- Correct closure knowledge timestamps without changing the frozen 0420 migration.
SET LOCAL lock_timeout = '2s';
CREATE OR REPLACE FUNCTION entity_record_window_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.valid_to_recorded_at := CASE WHEN NEW.valid_to IS NOT NULL THEN statement_timestamp() END;
    ELSIF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
        NEW.valid_to_recorded_at := statement_timestamp();
    ELSE
        NEW.valid_to_recorded_at := OLD.valid_to_recorded_at;
    END IF;
    RETURN NEW;
END $$;

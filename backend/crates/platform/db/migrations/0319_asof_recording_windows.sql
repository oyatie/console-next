-- CX-ideal-asof: preserve the recording time of closed effective windows.
-- Expand only; old readers and writers keep their existing columns.
SET LOCAL lock_timeout = '2s';
ALTER TABLE employment_assignments ADD COLUMN valid_to_recorded_at timestamptz;
ALTER TABLE org_unit_placements ADD COLUMN valid_to_recorded_at timestamptz;
COMMENT ON COLUMN employment_assignments.valid_to_recorded_at IS 'pd:none — recording time of the effective-window closure';
COMMENT ON COLUMN org_unit_placements.valid_to_recorded_at IS 'pd:none — recording time of the effective-window closure';

-- Existing closures predate recording-time tracking; retain their known state.
UPDATE employment_assignments SET valid_to_recorded_at = created_at WHERE valid_to IS NOT NULL;
UPDATE org_unit_placements SET valid_to_recorded_at = created_at WHERE valid_to IS NOT NULL;
CREATE FUNCTION entity_record_window_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.valid_to_recorded_at := CASE WHEN NEW.valid_to IS NOT NULL THEN now() END;
    ELSIF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
        NEW.valid_to_recorded_at := now();
    ELSE
        NEW.valid_to_recorded_at := OLD.valid_to_recorded_at;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER employment_assignments_record_close BEFORE INSERT OR UPDATE ON employment_assignments
    FOR EACH ROW EXECUTE FUNCTION entity_record_window_close();
CREATE TRIGGER org_unit_placements_record_close BEFORE INSERT OR UPDATE ON org_unit_placements
    FOR EACH ROW EXECUTE FUNCTION entity_record_window_close();
CREATE INDEX org_unit_revisions_temporal ON org_unit_revisions (org_id, org_unit_id, created_at);
CREATE INDEX legal_entity_revisions_temporal ON legal_entity_revisions (org_id, legal_entity_id, effective_from, created_at);
CREATE INDEX workplace_revisions_temporal ON workplace_revisions (org_id, workplace_id, effective_from, created_at);

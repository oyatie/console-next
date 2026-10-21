-- Expand: preserve the proposal, effective date and status used by known-at projections.
SET LOCAL lock_timeout = '2s';
ALTER TABLE org_change_requests ADD COLUMN projection_history jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(projection_history) = 'array');
COMMENT ON COLUMN org_change_requests.projection_history IS
    'pd:personal — immutable dated proposal snapshots; employee subset references, 개보법 제2조제1호나목 결합 식별';
-- Legacy rows have no recoverable proposal history before updated_at.
ALTER TABLE org_change_requests DISABLE TRIGGER trg_org_change_requests_terminal;
UPDATE org_change_requests SET projection_history = jsonb_build_array(jsonb_build_object(
    'recorded_at', updated_at, 'effective_date', effective_date, 'status', status, 'proposal', proposal));
ALTER TABLE org_change_requests ENABLE TRIGGER trg_org_change_requests_terminal;
CREATE FUNCTION record_org_projection_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.projection_history := jsonb_build_array(jsonb_build_object(
            'recorded_at', NEW.created_at, 'effective_date', NEW.effective_date,
            'status', NEW.status, 'proposal', NEW.proposal));
    ELSE
        IF NEW.projection_history IS DISTINCT FROM OLD.projection_history THEN
            RAISE EXCEPTION 'projection history is recorded by the database' USING ERRCODE = '23514';
        END IF;
        IF (NEW.effective_date, NEW.status, NEW.proposal) IS DISTINCT FROM
           (OLD.effective_date, OLD.status, OLD.proposal) THEN
            NEW.projection_history := OLD.projection_history || jsonb_build_array(jsonb_build_object(
                'recorded_at', statement_timestamp(), 'effective_date', NEW.effective_date,
                'status', NEW.status, 'proposal', NEW.proposal));
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_org_projection_history BEFORE INSERT OR UPDATE ON org_change_requests
    FOR EACH ROW EXECUTE FUNCTION record_org_projection_history();

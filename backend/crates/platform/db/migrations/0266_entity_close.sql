-- MR-14 / MR-15 (decisions #21: delete = close where retention applies).
--
-- 1. legal_entities.close_reason_code: why the 법인 closed (해산 or 폐업), set
--    together with closed_on, once. A closed 법인 is never reopened: its
--    closed_on and reason are set-once (separate trigger, so 0263's identifier
--    guard body is not replaced again).
-- 2. Backstop for every writer of employment_assignments (entity bind, ENT-ORG
--    moves, hr transfers): no current placement may run past the close of its
--    사업장 or 법인. Rows ending on or before the close (history, corrections)
--    stay allowed.
SET LOCAL lock_timeout = '2s';

ALTER TABLE legal_entities
    ADD COLUMN close_reason_code TEXT NULL CHECK (close_reason_code IN ('DISSOLVED', 'BUSINESS_CLOSED')),
    ADD CONSTRAINT legal_entities_close_shape CHECK ((closed_on IS NULL) = (close_reason_code IS NULL));
COMMENT ON COLUMN legal_entities.close_reason_code IS 'pd:none — DISSOLVED (해산) | BUSINESS_CLOSED (폐업); set with closed_on';
GRANT UPDATE (close_reason_code) ON legal_entities TO console_rt;

CREATE FUNCTION legal_entities_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.closed_on IS NOT NULL
       AND (NEW.closed_on, NEW.close_reason_code) IS DISTINCT FROM (OLD.closed_on, OLD.close_reason_code) THEN
        RAISE EXCEPTION 'legal entity % is closed; the close is set once (legal_entity_closed)', OLD.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER legal_entities_close_once BEFORE UPDATE ON legal_entities
    FOR EACH ROW EXECUTE FUNCTION legal_entities_close_once();

CREATE FUNCTION employment_assignments_open_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.superseded_at IS NULL AND EXISTS (
        SELECT 1 FROM workplaces w
        WHERE w.org_id = NEW.org_id AND w.id = NEW.workplace_id AND w.closed_on IS NOT NULL
          AND (NEW.valid_to IS NULL OR NEW.valid_to > w.closed_on)
    ) THEN
        RAISE EXCEPTION 'workplace % is closed (workplace_closed)', NEW.workplace_id;
    END IF;
    IF NEW.superseded_at IS NULL AND EXISTS (
        SELECT 1 FROM legal_entities e
        WHERE e.org_id = NEW.org_id AND e.id = NEW.legal_entity_id AND e.closed_on IS NOT NULL
          AND (NEW.valid_to IS NULL OR NEW.valid_to > e.closed_on)
    ) THEN
        RAISE EXCEPTION 'legal entity % is closed (legal_entity_closed)', NEW.legal_entity_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER employment_assignments_open_target BEFORE INSERT ON employment_assignments
    FOR EACH ROW EXECUTE FUNCTION employment_assignments_open_target();

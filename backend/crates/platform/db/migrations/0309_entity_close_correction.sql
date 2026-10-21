-- UX-R1 ENTITY (company-03; catalog company-19): a 법인's recorded close can be
-- corrected — a wrong 종료일 or 종료 사유 — as a ledgered 정정. 0266 made the
-- close set-once; the correction is the one writer allowed past it, inside
-- its own transaction (app.entity_close_correction = 'on', set LOCAL), and it
-- never reopens: closed_on and close_reason_code stay set. Withdrawing a close
-- (종료 취소) is not this migration's: it would reopen 사업장 and units.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION legal_entities_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.closed_on IS NOT NULL
       AND (NEW.closed_on, NEW.close_reason_code) IS DISTINCT FROM (OLD.closed_on, OLD.close_reason_code)
       AND NOT (coalesce(current_setting('app.entity_close_correction', true), '') = 'on'
                AND NEW.closed_on IS NOT NULL AND NEW.close_reason_code IS NOT NULL) THEN
        RAISE EXCEPTION 'legal entity % is closed; the close is set once (legal_entity_closed)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

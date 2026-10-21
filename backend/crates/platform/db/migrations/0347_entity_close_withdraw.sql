-- UX-R3 STRUCT (company-15; catalog company-19): a 법인's close can be
-- withdrawn (종료 취소) when the business goes on. 0266 made the close set
-- once and 0309 let the 정정 move its date or reason; the withdrawal is the
-- one writer allowed to clear both, inside its own transaction
-- (app.entity_close_withdraw = 'on', set LOCAL), and the 사업장 and 사업자등록
-- that closed with it reopen in the same command (a revision each, kept in
-- their history). Numbered from this lane's range (0335-0339); INTEG
-- renumbers. No seed rows.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION legal_entities_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.closed_on IS NOT NULL
       AND (NEW.closed_on, NEW.close_reason_code) IS DISTINCT FROM (OLD.closed_on, OLD.close_reason_code)
       AND NOT (coalesce(current_setting('app.entity_close_correction', true), '') = 'on'
                AND NEW.closed_on IS NOT NULL AND NEW.close_reason_code IS NOT NULL)
       AND NOT (coalesce(current_setting('app.entity_close_withdraw', true), '') = 'on'
                AND NEW.closed_on IS NULL AND NEW.close_reason_code IS NULL) THEN
        RAISE EXCEPTION 'legal entity % is closed; the close is set once (legal_entity_closed)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

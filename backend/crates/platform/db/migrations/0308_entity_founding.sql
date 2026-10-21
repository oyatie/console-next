-- UX-R1 ENTITY (company-08, catalog company-04): a 법인 recorded while it is
-- being founded (설립 중), before its 설립등기. It has no 법인등록번호 yet
-- (the 등기 assigns it) and no 설립등기일; its 사업자등록증 is typed when it
-- arrives. The founding ends, once, when the 법인등록번호 is first entered
-- (with the 설립등기일): founding is set at create and only ever cleared.
-- The trail items (설립등기, 법인설립신고, 사업자등록 …) are LIFECYCLE's.
SET LOCAL lock_timeout = '2s';

ALTER TABLE legal_entities
    ADD COLUMN founding BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT legal_entities_founding_shape CHECK (
        NOT founding OR ((biz_kind IS NULL OR biz_kind = 'CORPORATION') AND crn IS NULL));
COMMENT ON COLUMN legal_entities.founding IS 'pd:none — 설립 중: recorded before its 설립등기 (no 법인등록번호 yet); cleared once, when the number is entered';
GRANT UPDATE (founding) ON legal_entities TO console_rt;

CREATE FUNCTION legal_entities_founding_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.founding AND NOT OLD.founding THEN
        RAISE EXCEPTION 'legal entity % was founded; founding is never set again (legal_entity_founded)', OLD.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER legal_entities_founding_once BEFORE UPDATE OF founding ON legal_entities
    FOR EACH ROW EXECUTE FUNCTION legal_entities_founding_once();

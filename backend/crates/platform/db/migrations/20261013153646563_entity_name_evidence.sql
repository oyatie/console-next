-- Expand only: the optional English name of a 법인, and the recorded reason a
-- registration's classification may differ from its kind or 본점 role.
SET LOCAL lock_timeout = '2s';

ALTER TABLE legal_entity_revisions
    ADD COLUMN english_name TEXT CHECK (english_name IS NULL OR char_length(btrim(english_name)) BETWEEN 1 AND 200);

ALTER TABLE business_registration_revisions
    ADD COLUMN classification_reason TEXT CHECK (classification_reason IS NULL OR char_length(btrim(classification_reason)) BETWEEN 1 AND 1000);

COMMENT ON COLUMN legal_entity_revisions.english_name IS 'pd:none — optional English legal entity name; never substitutes for registered name';
COMMENT ON COLUMN business_registration_revisions.classification_reason IS 'pd:personal — explicit explanation for registration classification or primary head-office exception';

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Explicit pay-group configuration; no pay rule is inferred or backfilled.
SET LOCAL lock_timeout = '2s';
CREATE TABLE pay_groups (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id UUID NOT NULL,
    legal_entity_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    pay_date_rule TEXT NOT NULL CHECK (char_length(btrim(pay_date_rule)) BETWEEN 1 AND 200),
    base_period TEXT NOT NULL CHECK (char_length(btrim(base_period)) BETWEEN 1 AND 200),
    variable_period TEXT NOT NULL CHECK (char_length(btrim(variable_period)) BETWEEN 1 AND 200),
    proration TEXT NOT NULL CHECK (char_length(btrim(proration)) BETWEEN 1 AND 200),
    channel TEXT NOT NULL CHECK (char_length(btrim(channel)) BETWEEN 1 AND 200),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities(org_id, id) ON DELETE RESTRICT
);
ALTER TABLE pay_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON pay_groups
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON pay_groups FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON pay_groups TO console_rt;
COMMENT ON TABLE pay_groups IS 'Explicit pay rules for one legal entity; interpreted by later scheduling/calculation slices';
COMMENT ON COLUMN pay_groups.org_id IS 'pd:none — tenant boundary';
COMMENT ON COLUMN pay_groups.id IS 'pd:none — pay-group identifier';
COMMENT ON COLUMN pay_groups.legal_entity_id IS 'pd:none — owning legal entity';
COMMENT ON COLUMN pay_groups.name IS 'pd:none — pay-group label';
COMMENT ON COLUMN pay_groups.pay_date_rule IS 'pd:none — explicitly selected pay-date rule';
COMMENT ON COLUMN pay_groups.base_period IS 'pd:none — explicitly selected base-pay period';
COMMENT ON COLUMN pay_groups.variable_period IS 'pd:none — explicitly selected variable-pay period';
COMMENT ON COLUMN pay_groups.proration IS 'pd:none — explicitly selected proration rule';
COMMENT ON COLUMN pay_groups.channel IS 'pd:none — explicitly selected payment channel';

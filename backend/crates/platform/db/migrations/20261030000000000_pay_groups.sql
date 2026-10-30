-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Explicit pay-group configuration; no pay rule is inferred or backfilled.
SET LOCAL lock_timeout = '2s';
-- Shared validation for independently chosen base and variable periods.
CREATE FUNCTION pay_group_period_rule_valid(rule JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT COALESCE(jsonb_typeof(rule) = 'object'
        AND rule ?& ARRAY['start_day','month_offset']
        AND rule - ARRAY['start_day','month_offset'] = '{}'::jsonb
        AND (rule->'start_day' = '"FIRST"'::jsonb OR
            (jsonb_typeof(rule->'start_day') = 'number' AND rule->>'start_day' ~ '^([1-9]|1[0-9]|2[0-8])$'))
        AND jsonb_typeof(rule->'month_offset') = 'number'
        AND rule->>'month_offset' IN ('-1','0'), false)
$$;
CREATE TABLE pay_groups (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id UUID NOT NULL,
    legal_entity_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40 AND btrim(name) <> ''),
    pay_date_rule JSONB NOT NULL CHECK (COALESCE(
        jsonb_typeof(pay_date_rule) = 'object'
        AND pay_date_rule ?& ARRAY['day','month_offset','non_business_day']
        AND pay_date_rule - ARRAY['day','month_offset','non_business_day'] = '{}'::jsonb
        AND (pay_date_rule->'day' = '"LAST_DAY"'::jsonb OR
            (jsonb_typeof(pay_date_rule->'day') = 'number' AND pay_date_rule->>'day' ~ '^([1-9]|[12][0-9]|3[01])$'))
        AND jsonb_typeof(pay_date_rule->'month_offset') = 'number'
        AND pay_date_rule->>'month_offset' IN ('0','1')
        AND pay_date_rule->'non_business_day' IN ('"PREVIOUS"'::jsonb,'"NEXT"'::jsonb), false)),
    base_period JSONB NOT NULL CHECK (pay_group_period_rule_valid(base_period)),
    variable_period JSONB NOT NULL CHECK (pay_group_period_rule_valid(variable_period)),
    proration TEXT NOT NULL CHECK (proration IN ('CALENDAR_DAYS','SCHEDULED_WORKDAYS')),
    channel TEXT NOT NULL CHECK (channel IN ('ATTESTATION_ONLY','FILE_GENERIC')),
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

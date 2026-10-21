-- PA-ENT (decisions #14.2): the feature_catalog row for the Cedar-only
-- `legal_entity_manage` action, so 법인 administration is its own grantable
-- permission apart from the org-change grants. Numbered head+1 of this
-- lane's base (ENT-1, 0259); INTEG renumbers it (APPR also holds a 0260).
--
-- Reference data, not a seed row: a row makes a feature grantable, it grants
-- nothing (see 0209). `Feature::as_str` equals this key byte for byte.
SET LOCAL lock_timeout = '2s';

INSERT INTO feature_catalog (feature_key) VALUES ('legal_entity_manage')
ON CONFLICT (feature_key) DO NOTHING;

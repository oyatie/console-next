-- GOV-CED-1 (governance design §2.2): feature_catalog rows for the eight new
-- governance Cedar actions. Numbered head+1 of the lane's base (BW-29, 0254);
-- INTEG renumbers it, or folds these rows into its PREREG-2 migration (the
-- ON CONFLICT makes either order safe).
--
-- Reference data, not seed rows: a row makes a feature grantable, it grants
-- nothing (see 0209). The `Feature::as_str` arms equal these keys byte for byte.
-- Every one is Cedar-only: the legacy matrix denies all built-in roles.
SET LOCAL lock_timeout = '2s';

INSERT INTO feature_catalog (feature_key) VALUES
    ('access_review_decide'),
    ('audit_export'),
    ('exception_review'),
    ('exception_view'),
    ('legal_hold_manage'),
    ('policy_config_view'),
    ('privacy_audit_view'),
    ('retention_disposal_decide')
ON CONFLICT (feature_key) DO NOTHING;

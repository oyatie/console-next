-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Operator/apply-owned values; tenant runtime can read, never write.
CREATE TABLE platform_setting_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (key, effective_from)
);
REVOKE ALL ON platform_setting_overrides FROM PUBLIC, console_rt;
GRANT SELECT ON platform_setting_overrides TO console_rt;

CREATE FUNCTION platform_setting_override_check() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d RECORD; n BIGINT;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'platform_setting_overrides is append-only' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO d FROM setting_definition(NEW.key);
    IF d.kind IS NULL OR d.governance <> 'platform_only' THEN
        RAISE EXCEPTION 'setting_not_editable' USING ERRCODE = '23514';
    END IF;
    n := setting_ordinal(d.kind, d.codes, NEW.value);
    IF n IS NULL OR (d.kind = 'int' AND (n < d.min_value OR n > d.max_value)) THEN
        RAISE EXCEPTION 'setting_value_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform_setting_override_check() FROM PUBLIC;
CREATE TRIGGER platform_setting_override_guard BEFORE INSERT OR UPDATE OR DELETE
    ON platform_setting_overrides FOR EACH ROW EXECUTE FUNCTION platform_setting_override_check();

COMMENT ON COLUMN platform_setting_overrides.id IS 'pd:none — operator configuration version';
COMMENT ON COLUMN platform_setting_overrides.key IS 'pd:none — registry key, no secrets';
COMMENT ON COLUMN platform_setting_overrides.value IS 'pd:none — bounded registry value, no secrets';
COMMENT ON COLUMN platform_setting_overrides.effective_from IS 'pd:none — configuration effective time';

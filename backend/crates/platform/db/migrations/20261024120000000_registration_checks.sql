-- SPDX-License-Identifier: LicenseRef-Proprietary
-- N-1 keeps its verification columns; readers now derive evidence for the current number.
SET LOCAL lock_timeout = '2s';
ALTER TABLE business_registrations ADD COLUMN check_pack TEXT NOT NULL DEFAULT 'KR';
COMMENT ON COLUMN business_registrations.check_pack IS 'pd:none — issuing-authority pack key';

CREATE TABLE business_registration_checks (
    org_id UUID NOT NULL REFERENCES organizations(id),
    id UUID NOT NULL,
    registration_id UUID NOT NULL,
    brn_checked TEXT NOT NULL CHECK (brn_checked ~ '^[0-9]{10}$'),
    kind TEXT NOT NULL CHECK (kind IN ('STATUS', 'VALIDATE')),
    trigger TEXT NOT NULL CHECK (trigger IN ('USER', 'SCHEDULE')),
    b_stt_cd TEXT,
    reported_status TEXT CHECK (reported_status IN ('CONTINUING', 'SUSPENDED', 'CLOSED')),
    tax_type_cd TEXT,
    end_dt TEXT,
    utcc_yn TEXT,
    tax_type_change_dt TEXT,
    invoice_apply_dt TEXT,
    rbf_tax_type_cd TEXT,
    valid TEXT CHECK (valid IN ('01', '02')),
    not_registered BOOLEAN NOT NULL,
    fields_sent TEXT[] NOT NULL CHECK (fields_sent <@ ARRAY['b_no','start_dt','p_nm']::TEXT[]),
    response_sha256 TEXT NOT NULL CHECK (response_sha256 ~ '^[a-f0-9]{64}$'),
    provider_version TEXT NOT NULL,
    actor_id UUID,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations(org_id, id) DEFERRABLE INITIALLY DEFERRED,
    CHECK (trigger <> 'SCHEDULE' OR (kind = 'STATUS' AND actor_id IS NULL AND fields_sent = ARRAY['b_no']::TEXT[]))
);
CREATE INDEX business_registration_checks_latest ON business_registration_checks(org_id, registration_id, brn_checked, checked_at DESC, id DESC);
CREATE TRIGGER business_registration_checks_immutable BEFORE UPDATE OR DELETE ON business_registration_checks
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();

CREATE TABLE business_registration_check_schedule (
    org_id UUID NOT NULL REFERENCES organizations(id),
    registration_id UUID NOT NULL,
    due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, registration_id),
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations(org_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE business_registration_check_items (
    org_id UUID NOT NULL REFERENCES organizations(id),
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    registration_id UUID NOT NULL,
    check_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    closed_at TIMESTAMPTZ,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations(org_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (org_id, check_id) REFERENCES business_registration_checks(org_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX business_registration_check_one_open ON business_registration_check_items(org_id, registration_id) WHERE closed_at IS NULL;

-- A revision, reissue or number correction makes status checking due, independently of N-1 writers.
CREATE FUNCTION registration_check_due() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF TG_TABLE_NAME = 'business_registrations' THEN target := NEW.id; ELSE target := NEW.registration_id; END IF;
    INSERT INTO business_registration_check_schedule(org_id, registration_id, due_at)
    VALUES (NEW.org_id, target, now())
    ON CONFLICT (org_id, registration_id) DO UPDATE SET due_at = now();
    RETURN NEW;
END $$;
CREATE TRIGGER registration_check_head_due AFTER INSERT OR UPDATE OF brn ON business_registrations FOR EACH ROW EXECUTE FUNCTION registration_check_due();
CREATE TRIGGER registration_check_revision_due AFTER INSERT ON business_registration_revisions FOR EACH ROW EXECUTE FUNCTION registration_check_due();
INSERT INTO business_registration_check_schedule(org_id, registration_id) SELECT org_id, id FROM business_registrations;

CREATE FUNCTION registration_verification_tier(p_id UUID, p_brn TEXT, p_known TIMESTAMPTZ DEFAULT NULL) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT COALESCE((SELECT CASE WHEN kind = 'VALIDATE' AND valid = '01' THEN 'T2'
        WHEN b_stt_cd IS NOT NULL AND NOT not_registered THEN 'T1' ELSE 'NONE' END
      FROM business_registration_checks WHERE registration_id = p_id AND brn_checked = p_brn
        AND (p_known IS NULL OR checked_at <= p_known)
      ORDER BY checked_at DESC, id DESC LIMIT 1), 'NONE')
$$;
REVOKE ALL ON FUNCTION registration_verification_tier(UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registration_verification_tier(UUID,TEXT,TIMESTAMPTZ) TO console_rt;

ALTER TABLE business_registration_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registration_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registration_checks USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON business_registration_checks FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON business_registration_checks TO console_rt;
COMMENT ON COLUMN business_registration_checks.org_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.registration_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.brn_checked IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.kind IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.trigger IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.b_stt_cd IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.reported_status IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.tax_type_cd IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.end_dt IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.utcc_yn IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.tax_type_change_dt IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.invoice_apply_dt IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.rbf_tax_type_cd IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.valid IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.not_registered IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.fields_sent IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.response_sha256 IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.provider_version IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.actor_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_checks.checked_at IS 'pd:none — governed authority-check metadata, no personal request values';

ALTER TABLE business_registration_check_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registration_check_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registration_check_schedule USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON business_registration_check_schedule FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON business_registration_check_schedule TO console_rt;
COMMENT ON COLUMN business_registration_check_schedule.org_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_schedule.registration_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_schedule.due_at IS 'pd:none — governed authority-check metadata, no personal request values';

ALTER TABLE business_registration_check_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_registration_check_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON business_registration_check_items USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON business_registration_check_items FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON business_registration_check_items TO console_rt;
COMMENT ON COLUMN business_registration_check_items.org_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_items.id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_items.registration_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_items.check_id IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_items.created_at IS 'pd:none — governed authority-check metadata, no personal request values';
COMMENT ON COLUMN business_registration_check_items.closed_at IS 'pd:none — governed authority-check metadata, no personal request values';

-- Platform counter, no tenant rows or request data; only the bounded function is callable.
CREATE TABLE registration_check_daily_budget (
    day DATE PRIMARY KEY,
    attempts BIGINT NOT NULL CHECK (attempts >= 0)
);
REVOKE ALL ON registration_check_daily_budget FROM PUBLIC, console_rt;
COMMENT ON COLUMN registration_check_daily_budget.day IS 'pd:none — UTC quota window';
COMMENT ON COLUMN registration_check_daily_budget.attempts IS 'pd:none — platform-wide outbound number count';
CREATE FUNCTION claim_registration_check_budget(p_count BIGINT, p_limit BIGINT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE used BIGINT; claimed BIGINT;
BEGIN
    IF NULLIF(current_setting('app.current_org',true),'') IS NULL OR p_count < 1 OR p_limit < 1
       OR p_limit > (SELECT max_value FROM public.setting_definition('nts.check.daily_budget')) THEN
        RETURN 0;
    END IF;
    INSERT INTO public.registration_check_daily_budget(day,attempts) VALUES ((now() AT TIME ZONE 'UTC')::date,0) ON CONFLICT(day) DO NOTHING;
    SELECT attempts INTO used FROM public.registration_check_daily_budget WHERE day=(now() AT TIME ZONE 'UTC')::date FOR UPDATE;
    claimed := LEAST(p_count,GREATEST(0,p_limit-used));
    UPDATE public.registration_check_daily_budget SET attempts=attempts+claimed WHERE day=(now() AT TIME ZONE 'UTC')::date;
    RETURN claimed;
END $$;
REVOKE ALL ON FUNCTION claim_registration_check_budget(BIGINT,BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_registration_check_budget(BIGINT,BIGINT) TO console_rt;

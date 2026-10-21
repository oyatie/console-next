-- AUTH-ID (decisions #33; console-react docs/design/sign-in-identifier.md):
-- the sign-in ID 아이디@회사도메인, identifier-first passkeys, and UUIDv7 for
-- new account ids. Expand-only: N-1 code never reads the new table and never
-- sends an identifier.
--
-- 1. users.id DEFAULT uuidv7() (PostgreSQL 18). Existing v4 ids are kept;
--    the account UUID stays the only key (nothing references a 아이디).
-- 2. user_sign_in_ids: one row per 아이디 an account ever held. The current
--    one has retired_at NULL; a replaced one is an alias that still signs in
--    until alias_until and stays searchable for good. Rows are never deleted
--    while the account exists, so PRIMARY KEY (org_id, login) refuses any
--    value anyone in the tenant ever held: never reissued (#6, extended).
-- 3. A deferred constraint trigger gives every new account a default 아이디
--    at commit unless its transaction set one (an invite does): the linked
--    employee's 사번 when free, else 'u' + the UUID's random tail.
-- 4. Backfill: every existing account gets its default, oldest first.
-- 5. platform_sign_in_options(identifier): the one pre-auth read. Returns the
--    account and its credential ids, or (NULL, one synthetic id) for anything
--    unusable: HMAC-SHA256 of the identifier under a per-database pepper, so
--    an unknown identifier answers like a known one, the same way every time.
-- 6. system_reason_codes() regenerated: the sign_in_id_change reason domain.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. New account ids are time-ordered.
ALTER TABLE users ALTER COLUMN id SET DEFAULT uuidv7();

-- ---------------------------------------------------------------------------
-- 2. user_sign_in_ids
CREATE TABLE user_sign_in_ids (
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    login          TEXT        NOT NULL
        CHECK (login ~ '^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$' AND login !~ '[._-]{2}'),
    user_id        UUID        NOT NULL,
    effective_date DATE        NOT NULL,
    reason_code    TEXT        NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 64),
    note           TEXT        NULL CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
    assigned_by    UUID        NULL,
    assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at     TIMESTAMPTZ NULL,
    alias_until    TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, login),
    FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_by, org_id) REFERENCES users (id, org_id),
    CHECK ((retired_at IS NULL) = (alias_until IS NULL))
);
CREATE UNIQUE INDEX user_sign_in_ids_current_idx ON user_sign_in_ids (org_id, user_id)
    WHERE retired_at IS NULL;
CREATE INDEX user_sign_in_ids_user_idx ON user_sign_in_ids (org_id, user_id, assigned_at);

-- Kept: only the retirement may be written, once (retired_at with its alias_until).
-- A cascade from the account's own hard delete is the one way a row goes.
CREATE FUNCTION user_sign_in_ids_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
       OR (to_jsonb(NEW) - 'retired_at' - 'alias_until') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at' - 'alias_until') THEN
        RAISE EXCEPTION 'user_sign_in_ids rows are immutable except the retirement, once' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_user_sign_in_ids_guard BEFORE UPDATE ON user_sign_in_ids
    FOR EACH ROW EXECUTE FUNCTION user_sign_in_ids_guard();

-- ---------------------------------------------------------------------------
-- 3. The default 아이디 of an account (sign-in-identifier.md §3.2).
CREATE FUNCTION sign_in_id_default(p_org UUID, p_user UUID) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_login TEXT;
    v_hex   TEXT := replace(p_user::text, '-', '');
BEGIN
    SELECT btrim(regexp_replace(regexp_replace(lower(e.employee_number), '[^a-z0-9._-]+', '-', 'g'),
                                '([._-])[._-]+', '\1', 'g'), '._-')
      INTO v_login
      FROM users u JOIN employees e ON e.id = u.employee_id AND e.org_id = u.org_id
     WHERE u.id = p_user AND u.org_id = p_org;
    IF v_login ~ '^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$'
       AND NOT EXISTS (SELECT 1 FROM user_sign_in_ids WHERE org_id = p_org AND login = v_login) THEN
        RETURN v_login;
    END IF;
    -- The random tail: a v7 UUID's leading digits are its clock.
    FOR n IN 8..31 LOOP
        v_login := 'u' || right(v_hex, n);
        IF NOT EXISTS (SELECT 1 FROM user_sign_in_ids WHERE org_id = p_org AND login = v_login) THEN
            RETURN v_login;
        END IF;
    END LOOP;
    RAISE EXCEPTION 'no free default sign-in id for %', p_user USING ERRCODE = '23505';
END $$;
REVOKE ALL ON FUNCTION sign_in_id_default(UUID, UUID) FROM PUBLIC;
-- The invite path assigns the default in its own transaction, so its response names it.
GRANT EXECUTE ON FUNCTION sign_in_id_default(UUID, UUID) TO console_rt;

CREATE FUNCTION sign_in_id_assign_default() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
BEGIN
    -- At commit: skip an account deleted in its own transaction, or one whose
    -- transaction already set its 아이디 (an invite that names one).
    IF EXISTS (SELECT 1 FROM users WHERE id = NEW.id)
       AND NOT EXISTS (SELECT 1 FROM user_sign_in_ids
                        WHERE org_id = NEW.org_id AND user_id = NEW.id AND retired_at IS NULL) THEN
        INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code)
        VALUES (NEW.org_id, sign_in_id_default(NEW.org_id, NEW.id), NEW.id,
                (now() AT TIME ZONE 'Asia/Seoul')::date, 'SYSTEM_DEFAULT');
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION sign_in_id_assign_default() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_users_sign_in_id_default AFTER INSERT ON users
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION sign_in_id_assign_default();

-- ---------------------------------------------------------------------------
-- 4. Backfill, oldest account first (it wins a shared default).
DO $backfill$
DECLARE
    account RECORD;
BEGIN
    FOR account IN SELECT id, org_id FROM users ORDER BY created_at, id LOOP
        INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code)
        VALUES (account.org_id, sign_in_id_default(account.org_id, account.id), account.id,
                (now() AT TIME ZONE 'Asia/Seoul')::date, 'SYSTEM_DEFAULT');
    END LOOP;
END
$backfill$;

ALTER TABLE user_sign_in_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sign_in_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON user_sign_in_ids
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL PRIVILEGES ON user_sign_in_ids FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON user_sign_in_ids TO console_rt;
GRANT UPDATE (retired_at, alias_until) ON user_sign_in_ids TO console_rt;

COMMENT ON TABLE user_sign_in_ids IS 'AUTH-ID (#33): every 아이디 an account held; the current one has retired_at NULL, an old one is an alias and is never reissued';
COMMENT ON COLUMN user_sign_in_ids.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN user_sign_in_ids.login IS 'pd:personal — 아이디 (로그인 식별자, 회사 도메인 앞부분)';
COMMENT ON COLUMN user_sign_in_ids.user_id IS 'pd:personal — the account; row is a natural person';
COMMENT ON COLUMN user_sign_in_ids.effective_date IS 'pd:none — 변경 기준일';
COMMENT ON COLUMN user_sign_in_ids.reason_code IS 'pd:none — sign_in_id_change reason code, INVITE or SYSTEM_DEFAULT';
COMMENT ON COLUMN user_sign_in_ids.note IS 'pd:personal — 사유 메모(자유 기재, 개인정보가 섞일 수 있음)';
COMMENT ON COLUMN user_sign_in_ids.assigned_by IS 'pd:personal — user who set it; NULL = the system';
COMMENT ON COLUMN user_sign_in_ids.assigned_at IS 'pd:none — when it was recorded';
COMMENT ON COLUMN user_sign_in_ids.retired_at IS 'pd:none — when a newer 아이디 replaced it';
COMMENT ON COLUMN user_sign_in_ids.alias_until IS 'pd:none — the old 아이디 signs in until then';

-- ---------------------------------------------------------------------------
-- 5. The pre-auth read and its pepper.
-- console-gate: owner-only-table auth_security.sign_in_pepper (rationale: the HMAC key of synthetic credential ids; read only inside platform_sign_in_options)
CREATE TABLE auth_security.sign_in_pepper (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    pepper    BYTEA   NOT NULL CHECK (octet_length(pepper) = 32)
);
INSERT INTO auth_security.sign_in_pepper (pepper) VALUES (gen_random_bytes(32));
COMMENT ON COLUMN auth_security.sign_in_pepper.singleton IS 'pd:none — the one row';
COMMENT ON COLUMN auth_security.sign_in_pepper.pepper IS 'pd:none — random HMAC key for synthetic credential ids; derived from no person';
REVOKE ALL ON auth_security.sign_in_pepper FROM PUBLIC, console_rt, console_leave_cmd,
    console_ontology_cmd, console_platform_force_cmd, console_leave_definer, console_ontology_writer;

CREATE FUNCTION platform_sign_in_options(p_identifier TEXT)
RETURNS TABLE (user_id UUID, credential_ids TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_login  TEXT := split_part(p_identifier, '@', 1);
    v_domain TEXT := split_part(p_identifier, '@', 2);
    v_org    UUID;
    v_user   UUID;
    v_ids    TEXT[];
BEGIN
    -- Only the slug is a domain until domain verification ships (#33). A
    -- SUSPENDED or ARCHIVED tenant answers like an unknown one (synthetic); the
    -- platform tier's own row is ARCHIVED by design (0036) and stays usable.
    -- Session issue refuses an inactive tenant again after proof (tenant_inactive).
    SELECT s.org_id, s.user_id INTO v_org, v_user
      FROM organizations o
      JOIN user_sign_in_ids s ON s.org_id = o.id AND s.login = v_login
      JOIN users u ON u.id = s.user_id AND u.org_id = s.org_id
     WHERE o.slug = v_domain AND u.is_active
       AND (o.status = 'ACTIVE' OR o.id = '00000000-0000-0000-0000-00000000face'::uuid)
       AND (s.retired_at IS NULL OR s.alias_until > now());
    SELECT coalesce(array_agg(c.credential_id ORDER BY c.created_at, c.id), '{}')
      INTO v_ids
      FROM auth_webauthn_credentials c
     WHERE c.org_id = v_org AND c.user_id = v_user;
    IF cardinality(v_ids) = 0 THEN
        v_user := NULL;
        SELECT ARRAY[rtrim(translate(encode(hmac(convert_to(p_identifier, 'UTF8'), p.pepper, 'sha256'),
                                            'base64'), '+/', '-_'), '=')]
          INTO v_ids
          FROM auth_security.sign_in_pepper p;
    END IF;
    RETURN QUERY SELECT v_user, v_ids;
END $$;
REVOKE ALL ON FUNCTION platform_sign_in_options(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_sign_in_options(TEXT) TO console_rt;

-- The account topic carries a rename (the panel and the directory re-read).
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('user', 'user.sign_in_id.change', 'user', true);

-- ---------------------------------------------------------------------------
-- 6. Reason codes: the sign_in_id_change domain.
DROP FUNCTION system_reason_codes();

-- BEGIN GENERATED by console-settings-domain code_lists/tests.rs
CREATE FUNCTION system_reason_codes()
RETURNS TABLE (domain TEXT, code TEXT, requires_note BOOLEAN, sort INT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    VALUES
        ('org_change_reason', 'NEW_BUSINESS_SITE', false, 1),
        ('org_change_reason', 'CONSOLIDATION', false, 2),
        ('org_change_reason', 'WORK_REALLOCATION', false, 3),
        ('org_change_reason', 'RENAMING', false, 4),
        ('org_change_reason', 'COMPLIANCE_FINDING', false, 5),
        ('org_change_reason', 'OTHER', true, 6),
        ('org_change_reject', 'EFFECTIVE_DATE_REVIEW', false, 1),
        ('org_change_reject', 'INSUFFICIENT_BASIS', false, 2),
        ('org_change_reject', 'WRONG_TARGET', false, 3),
        ('org_change_reject', 'POLICY_VIOLATION', false, 4),
        ('org_change_reject', 'OTHER', true, 5),
        ('approval_return', 'NEEDS_SUPPLEMENT', false, 1),
        ('approval_return', 'ADD_EVIDENCE', false, 2),
        ('approval_return', 'ADJUST_EFFECTIVE_DATE', false, 3),
        ('approval_return', 'CORRECT_TARGET', false, 4),
        ('approval_return', 'OTHER', true, 5),
        ('org_change_cancel', 'DUPLICATE_DRAFT', false, 1),
        ('org_change_cancel', 'PLAN_CHANGED', false, 2),
        ('org_change_cancel', 'DRAFTING_ERROR', false, 3),
        ('org_change_cancel', 'OTHER', true, 4),
        ('org_change_withdraw', 'DUPLICATE_DRAFT', false, 1),
        ('org_change_withdraw', 'PLAN_CHANGED', false, 2),
        ('org_change_withdraw', 'DRAFTING_ERROR', false, 3),
        ('org_change_withdraw', 'OTHER', true, 4),
        ('lifecycle_transfer', 'REGULAR_RESHUFFLE', false, 1),
        ('lifecycle_transfer', 'REORGANIZATION', false, 2),
        ('lifecycle_transfer', 'EMPLOYEE_REQUEST', false, 3),
        ('lifecycle_transfer', 'BUSINESS_NEED', false, 4),
        ('lifecycle_transfer', 'OTHER', true, 5),
        ('lifecycle_promote', 'REGULAR_PROMOTION', false, 1),
        ('lifecycle_promote', 'SPECIAL_PROMOTION', false, 2),
        ('lifecycle_promote', 'DISCIPLINARY_DEMOTION', false, 3),
        ('lifecycle_promote', 'OTHER', true, 4),
        ('lifecycle_cancel', 'INPUT_ERROR', false, 1),
        ('lifecycle_cancel', 'SCHEDULE_CHANGED', false, 2),
        ('lifecycle_cancel', 'PLAN_WITHDRAWN', false, 3),
        ('lifecycle_cancel', 'OTHER', true, 4),
        ('exit_reason', 'PERSONAL', false, 1),
        ('exit_reason', 'FAMILY', false, 2),
        ('exit_reason', 'ILLNESS', false, 3),
        ('exit_reason', 'STUDY', false, 4),
        ('exit_reason', 'WORKING_CONDITIONS', false, 5),
        ('exit_reason', 'WAGE_ARREARS', false, 6),
        ('exit_reason', 'RELOCATION', false, 7),
        ('exit_reason', 'CLOSURE', false, 8),
        ('exit_reason', 'INSOLVENCY', false, 9),
        ('exit_reason', 'ADVISED_RESIGNATION_BUSINESS', false, 10),
        ('exit_reason', 'REDUNDANCY_DISMISSAL', false, 11),
        ('exit_reason', 'DISCIPLINARY_DISMISSAL', false, 12),
        ('exit_reason', 'ADVISED_RESIGNATION_FAULT', false, 13),
        ('exit_reason', 'RETIREMENT_AGE', false, 14),
        ('exit_reason', 'CONTRACT_END', false, 15),
        ('exit_reason', 'PROJECT_END', false, 16),
        ('exit_reason', 'COVERAGE_EXCLUDED', false, 17),
        ('exit_reason', 'DUAL_EMPLOYMENT', false, 18),
        ('exit_reason', 'DEATH', false, 19),
        ('exit_reason', 'OTHER', true, 20),
        ('exit_reject', 'EMPLOYEE_WITHDREW', false, 1),
        ('exit_reject', 'NOT_FACTUAL', false, 2),
        ('exit_reject', 'OTHER', true, 3),
        ('exit_cancel', 'EMPLOYEE_WITHDREW', false, 1),
        ('exit_cancel', 'REPORT_ERROR', false, 2),
        ('exit_cancel', 'OTHER', true, 3),
        ('period_lock', 'MONTHLY_PAYROLL_CLOSE', false, 1),
        ('period_lock', 'BOOKS_CLOSE', false, 2),
        ('period_lock', 'TAX_FILING', false, 3),
        ('period_lock', 'AUDIT_RESPONSE', false, 4),
        ('period_lock', 'OTHER', true, 5),
        ('period_unlock', 'RETRO_CORRECTION', false, 1),
        ('period_unlock', 'PAYROLL_ERROR', false, 2),
        ('period_unlock', 'AUDIT_FINDING', false, 3),
        ('period_unlock', 'OTHER', true, 4),
        ('role_change', 'PROMOTION_OR_REASSIGNMENT', false, 1),
        ('role_change', 'EXIT_OR_LEAVE', false, 2),
        ('role_change', 'ACCESS_CLEANUP', false, 3),
        ('role_change', 'ERROR_CORRECTION', false, 4),
        ('role_change', 'OTHER', true, 5),
        ('deactivate', 'EXIT', false, 1),
        ('deactivate', 'LEAVE', false, 2),
        ('deactivate', 'SECURITY_INCIDENT', false, 3),
        ('deactivate', 'DUPLICATE_ACCOUNT', false, 4),
        ('deactivate', 'OTHER', true, 5),
        ('credential_reset', 'DEVICE_LOST', false, 1),
        ('credential_reset', 'DEVICE_REPLACED', false, 2),
        ('credential_reset', 'COMPROMISE_SUSPECTED', false, 3),
        ('credential_reset', 'OTHER', true, 4),
        ('import_exclude', 'DUPLICATE', false, 1),
        ('import_exclude', 'FORMAT_ERROR', false, 2),
        ('import_exclude', 'OUT_OF_SCOPE', false, 3),
        ('import_exclude', 'OTHER', true, 4),
        ('exception', 'OTHER', true, 1),
        ('retained_record_purpose', 'EMPLOYMENT_CERTIFICATE', false, 1),
        ('retained_record_purpose', 'SEPARATION_CONFIRMATION', false, 2),
        ('retained_record_purpose', 'PAYMENT_STATEMENT_FILING', false, 3),
        ('retained_record_purpose', 'WITHHOLDING_CORRECTION', false, 4),
        ('retained_record_purpose', 'EXIT_PROCESSING_COMPLETION', false, 5),
        ('retained_record_purpose', 'DISPUTE_OR_INSPECTION', false, 6),
        ('retained_record_purpose', 'DATA_SUBJECT_ACCESS', false, 7),
        ('retained_record_purpose', 'OTHER', true, 8),
        ('restricted_record_purpose', 'STATUTORY_REPORTING', false, 1),
        ('restricted_record_purpose', 'WORK_ACCOMMODATION', false, 2),
        ('restricted_record_purpose', 'DISCIPLINARY_PROCEDURE', false, 3),
        ('restricted_record_purpose', 'RECORD_CORRECTION', false, 4),
        ('restricted_record_purpose', 'DISPUTE_OR_INSPECTION', false, 5),
        ('restricted_record_purpose', 'DATA_SUBJECT_ACCESS', false, 6),
        ('restricted_record_purpose', 'OTHER', true, 7),
        ('rrn_reveal', 'PAYROLL_WITHHOLDING', false, 1),
        ('rrn_reveal', 'SOCIAL_INSURANCE_FILING', false, 2),
        ('rrn_reveal', 'IDENTITY_VERIFICATION', false, 3),
        ('rrn_reveal', 'DATA_SUBJECT_ACCESS', false, 4),
        ('rrn_reveal', 'OTHER', true, 5),
        ('employee_number_change', 'NUMBERING_SCHEME_CHANGE', false, 1),
        ('employee_number_change', 'ENTITY_TRANSFER', false, 2),
        ('employee_number_change', 'INPUT_ERROR', false, 3),
        ('employee_number_change', 'LEGACY_MIGRATION', false, 4),
        ('employee_number_change', 'OTHER', true, 5),
        ('sign_in_id_change', 'NAME_CHANGE', false, 1),
        ('sign_in_id_change', 'INPUT_ERROR', false, 2),
        ('sign_in_id_change', 'HOLDER_REQUEST', false, 3),
        ('sign_in_id_change', 'SECURITY_INCIDENT', false, 4),
        ('sign_in_id_change', 'OTHER', true, 5)
$$;
-- END GENERATED

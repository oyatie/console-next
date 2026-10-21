-- ENT-REG (MR-17, MR-18; decisions #21 full CRUD): identifier corrections
-- and 사업장 registration-link changes, each kept as a dated ledger row.
--
-- Lane number: head+1 of the ENT-REG stack (hard/pa/ent 0260/0261 +
-- hard/entity-capture 0260 -> 0262 renumbered in the stack merge); INTEG
-- renumbers at the batch merge.
--
-- 1. entity_identifier_corrections: a change of 사업자 구분, 법인등록번호 or
--    사업자등록번호 is a correction with evidence (an attached entity
--    document) and a closed reason, never a silent overwrite. Before 운영 시작
--    it applies at once (SETUP); after, only through a consumed governed
--    exception (BW-06 rule ENTITY_IDENTIFIER_CORRECTION, HIGH: a second
--    person, or the decisions #7 case-B sole-holder fallback). Correcting
--    사업자 구분 away from CORPORATION clears the 법인등록번호 in the same
--    command: two rows, one exception.
-- 2. The identity lock triggers (0257) now let a locked identifier change
--    only in the same transaction as a governed ledger row for exactly that
--    value. Everything else stays refused at the DB.
-- 3. workplace_registration_changes: a 사업장 moving to another 사업자등록 or
--    종사업장 일련번호 (부가세법 §8③–⑤; 시행규칙 별지 제7호서식 부표), dated,
--    with the before and after.
-- 4. governed_exceptions.subject_type gains LEGAL_ENTITY and
--    BUSINESS_REGISTRATION. GOV-EXC-1 (0260_gov_exc1_policy_change) and LOCK
--    (BW-15) widen the same CHECK: INTEG keeps the union in the later one.
--
-- No seed rows. Writer crate: console-entity-adapter-postgres.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. entity_identifier_corrections
CREATE TABLE entity_identifier_corrections (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    legal_entity_id UUID        NOT NULL,
    registration_id UUID        NULL,
    field           TEXT        NOT NULL CHECK (field IN ('biz_kind', 'crn', 'brn')),
    old_value       TEXT        NULL,
    new_value       TEXT        NULL,
    reason_code     TEXT        NOT NULL CHECK (reason_code IN ('TYPO_AT_ENTRY', 'REGISTRY_DIFFERS', 'OTHER_EVIDENCED')),
    document_id     UUID        NOT NULL,
    exception_id    UUID        NULL REFERENCES governed_exceptions(id) ON DELETE RESTRICT,
    change_mode     TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER')),
    actor_id        UUID        NOT NULL,
    command_id      UUID        NOT NULL,
    xact_id         XID8        NOT NULL DEFAULT pg_current_xact_id(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id, field),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, document_id) REFERENCES entity_documents (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT entity_identifier_corrections_target CHECK ((field = 'brn') = (registration_id IS NOT NULL)),
    CONSTRAINT entity_identifier_corrections_value CHECK (
        (field = 'biz_kind' AND new_value IN ('CORPORATION', 'INDIVIDUAL', 'ID_NUMBER_ORG'))
        OR (field = 'crn' AND (new_value IS NULL OR new_value ~ '^[0-9]{13}$'))
        OR (field = 'brn' AND new_value ~ '^[0-9]{10}$')
    ),
    CONSTRAINT entity_identifier_corrections_changed CHECK (old_value IS DISTINCT FROM new_value),
    CONSTRAINT entity_identifier_corrections_governed CHECK ((change_mode = 'SETUP') = (exception_id IS NULL))
);
CREATE INDEX entity_identifier_corrections_entity_idx ON entity_identifier_corrections (org_id, legal_entity_id);
CREATE UNIQUE INDEX entity_identifier_corrections_exception_uniq ON entity_identifier_corrections (exception_id, field)
    WHERE exception_id IS NOT NULL;

ALTER TABLE entity_identifier_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_identifier_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON entity_identifier_corrections
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_entity_identifier_corrections_append_only BEFORE UPDATE OR DELETE ON entity_identifier_corrections
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON entity_identifier_corrections FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON entity_identifier_corrections TO console_rt;
COMMENT ON TABLE entity_identifier_corrections IS '사업자 구분 / 법인등록번호 / 사업자등록번호 corrections with evidence (append-only ledger; MR-17)';
COMMENT ON COLUMN entity_identifier_corrections.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN entity_identifier_corrections.id IS 'pd:none — row id';
COMMENT ON COLUMN entity_identifier_corrections.legal_entity_id IS 'pd:none — the 법인 whose identifier changed (or that holds the registration)';
COMMENT ON COLUMN entity_identifier_corrections.registration_id IS 'pd:none — the 사업자등록 whose number changed; NULL for a 법인 field';
COMMENT ON COLUMN entity_identifier_corrections.field IS 'pd:none — biz_kind | crn | brn';
COMMENT ON COLUMN entity_identifier_corrections.old_value IS 'pd:none — value before (canonical code or digits; NULL when there was none)';
COMMENT ON COLUMN entity_identifier_corrections.new_value IS 'pd:none — value after (canonical code or digits); NULL only for a crn cleared because 사업자 구분 left CORPORATION';
COMMENT ON COLUMN entity_identifier_corrections.reason_code IS 'pd:none — TYPO_AT_ENTRY | REGISTRY_DIFFERS | OTHER_EVIDENCED';
COMMENT ON COLUMN entity_identifier_corrections.document_id IS 'pd:none — the evidence kept (등기사항전부증명서 or 사업자등록증)';
COMMENT ON COLUMN entity_identifier_corrections.exception_id IS 'pd:none — the consumed governed exception (after 운영 시작); NULL in SETUP';
COMMENT ON COLUMN entity_identifier_corrections.change_mode IS 'pd:none — SETUP | GOVERNED | SOLE_HOLDER';
COMMENT ON COLUMN entity_identifier_corrections.actor_id IS 'pd:personal — user who corrected it';
COMMENT ON COLUMN entity_identifier_corrections.command_id IS 'pd:none — the request Idempotency-Key';
COMMENT ON COLUMN entity_identifier_corrections.xact_id IS 'pd:none — writing transaction; the identity lock trigger matches it';
COMMENT ON COLUMN entity_identifier_corrections.created_at IS 'pd:none — when it was recorded';

-- ---------------------------------------------------------------------------
-- 2. The identity locks admit a governed correction of exactly this value.
CREATE FUNCTION entity_identifier_governed(
    p_org UUID, p_entity UUID, p_registration UUID, p_field TEXT, p_value TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM entity_identifier_corrections c
        WHERE c.org_id = p_org AND c.legal_entity_id = p_entity
          AND c.registration_id IS NOT DISTINCT FROM p_registration
          AND c.field = p_field AND c.new_value IS NOT DISTINCT FROM p_value
          AND c.exception_id IS NOT NULL AND c.xact_id = pg_current_xact_id()
    )
$$;

CREATE OR REPLACE FUNCTION legal_entities_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.id, NEW.created_change_mode, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.created_change_mode, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'legal_entities identity columns are immutable (id=%)', OLD.id;
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'legal entity % is voided and read-only', OLD.id;
    END IF;
    IF OLD.identity_locked_at IS NOT NULL AND (
        NEW.identity_locked_at IS DISTINCT FROM OLD.identity_locked_at
        OR (NEW.biz_kind IS DISTINCT FROM OLD.biz_kind
            AND NOT entity_identifier_governed(OLD.org_id, OLD.id, NULL, 'biz_kind', NEW.biz_kind))
        OR (NEW.crn IS DISTINCT FROM OLD.crn
            AND NOT entity_identifier_governed(OLD.org_id, OLD.id, NULL, 'crn', NEW.crn))
    ) THEN
        RAISE EXCEPTION 'legal entity % identity is locked (identifier_locked)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION business_registrations_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.id, NEW.legal_entity_id, NEW.created_change_mode, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.legal_entity_id, OLD.created_change_mode, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'business_registrations identity columns are immutable (id=%)', OLD.id;
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'business registration % is voided and read-only', OLD.id;
    END IF;
    IF OLD.identity_locked_at IS NOT NULL AND (
        NEW.identity_locked_at IS DISTINCT FROM OLD.identity_locked_at
        OR (NEW.brn IS DISTINCT FROM OLD.brn
            AND NOT entity_identifier_governed(OLD.org_id, OLD.legal_entity_id, OLD.id, 'brn', NEW.brn))
    ) THEN
        RAISE EXCEPTION 'business registration % number is locked (identifier_locked)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3. workplace_registration_changes
CREATE TABLE workplace_registration_changes (
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
    workplace_id         UUID        NOT NULL,
    from_registration_id UUID        NULL,
    from_sub_serial      TEXT        NULL,
    to_registration_id   UUID        NULL,
    to_sub_serial        TEXT        NULL CHECK (to_sub_serial IS NULL OR (to_sub_serial ~ '^[0-9]{4}$' AND to_sub_serial <> '0000')),
    effective_from       DATE        NOT NULL,
    reason_code          TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    change_mode          TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED')),
    actor_id             UUID        NOT NULL,
    command_id           UUID        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id),
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, from_registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, to_registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT workplace_registration_changes_changed CHECK (
        (from_registration_id, from_sub_serial) IS DISTINCT FROM (to_registration_id, to_sub_serial)
    ),
    CONSTRAINT workplace_registration_changes_serial_needs_registration CHECK (to_sub_serial IS NULL OR to_registration_id IS NOT NULL)
);
CREATE INDEX workplace_registration_changes_workplace_idx ON workplace_registration_changes (org_id, workplace_id);

ALTER TABLE workplace_registration_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplace_registration_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workplace_registration_changes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_workplace_registration_changes_append_only BEFORE UPDATE OR DELETE ON workplace_registration_changes
    FOR EACH ROW EXECUTE FUNCTION entity_record_append_only();
REVOKE ALL PRIVILEGES ON workplace_registration_changes FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON workplace_registration_changes TO console_rt;
COMMENT ON TABLE workplace_registration_changes IS '사업장 → 사업자등록 link and 종사업장 일련번호 changes, dated (append-only ledger; MR-18)';
COMMENT ON COLUMN workplace_registration_changes.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN workplace_registration_changes.id IS 'pd:none — row id';
COMMENT ON COLUMN workplace_registration_changes.workplace_id IS 'pd:none — the 사업장 that moved';
COMMENT ON COLUMN workplace_registration_changes.from_registration_id IS 'pd:none — 사업자등록 before';
COMMENT ON COLUMN workplace_registration_changes.from_sub_serial IS 'pd:none — 종사업장 일련번호 before';
COMMENT ON COLUMN workplace_registration_changes.to_registration_id IS 'pd:none — 사업자등록 after';
COMMENT ON COLUMN workplace_registration_changes.to_sub_serial IS 'pd:none — 종사업장 일련번호 after';
COMMENT ON COLUMN workplace_registration_changes.effective_from IS 'pd:none — when the new link took effect (KST date, not after the day recorded)';
COMMENT ON COLUMN workplace_registration_changes.reason_code IS 'pd:none — BW-07 reason code';
COMMENT ON COLUMN workplace_registration_changes.change_mode IS 'pd:none — SETUP | GOVERNED';
COMMENT ON COLUMN workplace_registration_changes.actor_id IS 'pd:personal — user who recorded it';
COMMENT ON COLUMN workplace_registration_changes.command_id IS 'pd:none — the request Idempotency-Key';
COMMENT ON COLUMN workplace_registration_changes.created_at IS 'pd:none — when it was recorded';

-- ---------------------------------------------------------------------------
-- 4. governed exceptions about a 법인 or a 사업자등록.
ALTER TABLE governed_exceptions DROP CONSTRAINT governed_exceptions_subject_type_check;
ALTER TABLE governed_exceptions ADD CONSTRAINT governed_exceptions_subject_type_check
    CHECK (subject_type IN (
        'EMPLOYMENT_EVENT', 'ATTENDANCE_RECORD', 'ORG_CHANGE', 'EXIT_CASE',
        'EMPLOYEE', 'USER_ACCOUNT', 'PAYROLL_RUN', 'ORGANIZATION',
        'LEGAL_ENTITY', 'BUSINESS_REGISTRATION'
    ));

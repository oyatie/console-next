-- BW-06: governed exception record (예외 처리) and attestations of offline facts.
--
-- Spec: backend-work.md BW-06 as amended by decisions.md (#3 attestations, #5
-- retro guard, #7 sole-holder fallback, BW-06 amendments). No scoped unlock: an
-- approved exception admits ONE fingerprinted write through the shared guard
-- (console_governance_domain::exception::check_admits) and is consumed in that
-- write's transaction.
--
-- No seed rows. Rule codes are code-defined (governance-domain `rules!`); the DB
-- checks only their format, so a new rule needs no migration. No policy values:
-- expires_at (`exceptions.approval_ttl_days`) and review_due_at
-- (`review.sole_holder_exception.due`) are computed by the domain from settings,
-- and the values used are stored in settings_snapshot.
--
-- "Append-only": a row is never deleted, and its request columns never change.
-- The only updates are the one-shot decision (PENDING -> APPROVED | DECLINED)
-- and the one-shot consumption, enforced by trigger + column-level GRANT.
--
-- Tenant removal: both tables hold a single-column RESTRICT `org_id` FK, so
-- platform_force_remove_direct_org_children's catalog sweep (0208) deletes them,
-- attestations first (descending OID). The delete guard below lets exactly that
-- sweep through: it returns OLD only while `app.platform_force_remove_org` is on,
-- which platform_force_remove_organization (0228) sets around the sweep. This
-- migration deliberately does NOT `CREATE OR REPLACE` either removal function:
-- that is last-writer-wins across the FOUND migrations landing together. The
-- GUC is settable by any role; console_rt has no DELETE grant, which is the
-- real barrier.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 0. Shared helpers
-- The one fingerprint definition: SHA-256 hex of the canonical write payload
-- plus the sorted affected periods. jsonb text is key-sorted; DateStyle is
-- pinned so a daterange always renders the same. Request and consume both call
-- it, so they cannot drift.
CREATE FUNCTION governed_exception_fingerprint(payload JSONB, periods DATERANGE[])
RETURNS TEXT
LANGUAGE sql STABLE STRICT PARALLEL SAFE
SET datestyle = 'ISO, YMD'
AS $$
    SELECT encode(sha256(convert_to(jsonb_build_array(
        payload,
        ARRAY(SELECT p::text FROM unnest(periods) AS p ORDER BY p)
    )::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION governed_exceptions_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append-only governance record % forbids %', TG_TABLE_NAME, TG_OP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. governed_exceptions
CREATE TABLE governed_exceptions (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    rule_code            TEXT        NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    risk                 TEXT        NOT NULL CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH')),
    subject_type         TEXT        NOT NULL CHECK (subject_type IN (
                             'EMPLOYMENT_EVENT', 'ATTENDANCE_RECORD', 'ORG_CHANGE', 'EXIT_CASE',
                             'EMPLOYEE', 'USER_ACCOUNT', 'PAYROLL_RUN', 'ORGANIZATION'
                         )),
    subject_id           UUID        NOT NULL,
    reason_code          TEXT        NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    note                 TEXT        NULL
                             CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)),
    fingerprint          TEXT        NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    affected_periods     DATERANGE[] NOT NULL DEFAULT '{}',
    settings_snapshot    JSONB       NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
    requested_by         UUID        NOT NULL,
    step_up_assertion_id UUID        NULL,
    status               TEXT        NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'RECORDED')),
    fallback_kind        TEXT        NULL CHECK (fallback_kind IN ('SECOND_PERSON', 'SOLE_HOLDER')),
    review_due_at        TIMESTAMPTZ NULL,
    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by           UUID        NULL,
    decided_at           TIMESTAMPTZ NULL,
    decision_reason_code TEXT        NULL CHECK (decision_reason_code IS NULL
                             OR char_length(btrim(decision_reason_code)) BETWEEN 1 AND 100),
    decision_note        TEXT        NULL CHECK (decision_note IS NULL
                             OR (btrim(decision_note) <> '' AND char_length(decision_note) <= 1000)),
    decision_step_up_assertion_id UUID NULL,
    consumed_at          TIMESTAMPTZ NULL,
    UNIQUE (id, org_id),
    FOREIGN KEY (requested_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (decided_by, org_id)   REFERENCES users(id, org_id) ON DELETE RESTRICT,
    -- The SoD backstop cited by decisions.md #5/#7 (spec name: approved_by).
    -- decided_by also covers DECLINE: nobody decides their own request.
    CONSTRAINT governed_exceptions_no_self_decision
        CHECK (decided_by IS NULL OR decided_by <> requested_by),
    -- Decided iff APPROVED/DECLINED; the decision columns travel together.
    CONSTRAINT governed_exceptions_decision_shape CHECK (
        (status IN ('APPROVED', 'DECLINED')) = (decided_by IS NOT NULL)
        AND (decided_by IS NULL) = (decided_at IS NULL)
        AND (decided_by IS NULL) = (decision_reason_code IS NULL)
        AND (decided_by IS NOT NULL OR decision_note IS NULL)
        AND (status <> 'APPROVED' OR decision_step_up_assertion_id IS NOT NULL)
        AND (status = 'APPROVED' OR decision_step_up_assertion_id IS NULL)
    ),
    -- HIGH always names its fallback; only SECOND_PERSON ever waits for a decision.
    CONSTRAINT governed_exceptions_fallback_shape CHECK (
        (risk = 'HIGH') = (fallback_kind IS NOT NULL)
        AND (fallback_kind IS NOT DISTINCT FROM 'SECOND_PERSON') = (status <> 'RECORDED')
        AND (fallback_kind IS NOT DISTINCT FROM 'SOLE_HOLDER') = (review_due_at IS NOT NULL)
    ),
    -- MEDIUM and the sole-holder fallback are admitted only with a step-up.
    CONSTRAINT governed_exceptions_step_up_shape CHECK (
        NOT (risk = 'MEDIUM' OR fallback_kind IS NOT DISTINCT FROM 'SOLE_HOLDER')
        OR step_up_assertion_id IS NOT NULL
    ),
    CONSTRAINT governed_exceptions_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT governed_exceptions_consumed_when_admitted
        CHECK (consumed_at IS NULL OR status IN ('APPROVED', 'RECORDED'))
);

CREATE INDEX governed_exceptions_org_status_idx
    ON governed_exceptions (org_id, status, created_at DESC);
CREATE INDEX governed_exceptions_org_rule_idx
    ON governed_exceptions (org_id, rule_code, created_at DESC);
CREATE INDEX governed_exceptions_org_subject_idx
    ON governed_exceptions (org_id, subject_type, subject_id);

CREATE OR REPLACE FUNCTION governed_exceptions_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.org_id, NEW.rule_code, NEW.risk, NEW.subject_type, NEW.subject_id,
        NEW.reason_code, NEW.note, NEW.fingerprint, NEW.affected_periods,
        NEW.settings_snapshot, NEW.requested_by, NEW.step_up_assertion_id,
        NEW.fallback_kind, NEW.review_due_at, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.rule_code, OLD.risk, OLD.subject_type, OLD.subject_id,
        OLD.reason_code, OLD.note, OLD.fingerprint, OLD.affected_periods,
        OLD.settings_snapshot, OLD.requested_by, OLD.step_up_assertion_id,
        OLD.fallback_kind, OLD.review_due_at, OLD.expires_at, OLD.created_at) THEN
        RAISE EXCEPTION 'governed_exceptions request columns are immutable (id=%)', OLD.id;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'DECLINED')) THEN
            RAISE EXCEPTION 'governed_exceptions illegal status change % -> % (id=%)',
                OLD.status, NEW.status, OLD.id;
        END IF;
    ELSIF (NEW.decided_by, NEW.decided_at, NEW.decision_reason_code, NEW.decision_note,
           NEW.decision_step_up_assertion_id)
          IS DISTINCT FROM
          (OLD.decided_by, OLD.decided_at, OLD.decision_reason_code, OLD.decision_note,
           OLD.decision_step_up_assertion_id) THEN
        RAISE EXCEPTION 'governed_exceptions decision is write-once (id=%)', OLD.id;
    END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'governed_exceptions consumption is single-use (id=%)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE governed_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON governed_exceptions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_governed_exceptions_org_immutable BEFORE UPDATE ON governed_exceptions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_governed_exceptions_write_once BEFORE UPDATE ON governed_exceptions
    FOR EACH ROW EXECUTE FUNCTION governed_exceptions_write_once();
CREATE TRIGGER trg_governed_exceptions_no_delete BEFORE DELETE ON governed_exceptions
    FOR EACH ROW EXECUTE FUNCTION governed_exceptions_delete_guard();

REVOKE ALL PRIVILEGES ON governed_exceptions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON governed_exceptions TO console_rt;
GRANT UPDATE (status, decided_by, decided_at, decision_reason_code, decision_note,
              decision_step_up_assertion_id, consumed_at) ON governed_exceptions TO console_rt;

COMMENT ON TABLE governed_exceptions IS 'BW-06 governed exception (예외 처리): a soft-rule override or an attested fact; admits one fingerprinted write';
COMMENT ON COLUMN governed_exceptions.id IS 'pd:none — exception id';
COMMENT ON COLUMN governed_exceptions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN governed_exceptions.rule_code IS 'pd:none — code-defined rule or fact code (governance-domain RuleCode)';
COMMENT ON COLUMN governed_exceptions.risk IS 'pd:none — rule risk tier at request time';
COMMENT ON COLUMN governed_exceptions.subject_type IS 'pd:none — kind of record the exception is about';
COMMENT ON COLUMN governed_exceptions.subject_id IS 'pd:none — logical id of that record (no FK: spans lanes)';
COMMENT ON COLUMN governed_exceptions.reason_code IS 'pd:none — BW-07 reason code';
COMMENT ON COLUMN governed_exceptions.note IS 'pd:personal — requester note (free text about the subject)';
COMMENT ON COLUMN governed_exceptions.fingerprint IS 'pd:none — SHA-256 of the canonical payload plus affected_periods';
COMMENT ON COLUMN governed_exceptions.affected_periods IS 'pd:none — payroll/accounting periods the admitted write touches';
COMMENT ON COLUMN governed_exceptions.settings_snapshot IS 'pd:none — settings values the exception was admitted under (D0.3)';
COMMENT ON COLUMN governed_exceptions.requested_by IS 'pd:personal — user who requested the exception';
COMMENT ON COLUMN governed_exceptions.step_up_assertion_id IS 'pd:none — requester step-up; logical ref, no FK (0144 ceremonies cascade-delete)';
COMMENT ON COLUMN governed_exceptions.status IS 'pd:none — PENDING | APPROVED | DECLINED | RECORDED';
COMMENT ON COLUMN governed_exceptions.fallback_kind IS 'pd:none — HIGH only: SECOND_PERSON or SOLE_HOLDER (decisions.md #7)';
COMMENT ON COLUMN governed_exceptions.review_due_at IS 'pd:none — sole-holder 사후 검토 due time';
COMMENT ON COLUMN governed_exceptions.expires_at IS 'pd:none — approval TTL end; an unconsumed exception is dead after it';
COMMENT ON COLUMN governed_exceptions.created_at IS 'pd:none — request time';
COMMENT ON COLUMN governed_exceptions.decided_by IS 'pd:personal — second person who approved or declined';
COMMENT ON COLUMN governed_exceptions.decided_at IS 'pd:none — decision time';
COMMENT ON COLUMN governed_exceptions.decision_reason_code IS 'pd:none — BW-07 reason code of the decision';
COMMENT ON COLUMN governed_exceptions.decision_note IS 'pd:personal — decider note (free text about the subject)';
COMMENT ON COLUMN governed_exceptions.decision_step_up_assertion_id IS 'pd:none — EXCEPTION_DECIDE step-up; logical ref, no FK';
COMMENT ON COLUMN governed_exceptions.consumed_at IS 'pd:none — when the single admitted write used the exception';

-- ---------------------------------------------------------------------------
-- 2. governed_exception_attestations: what an attested fact carries
--    (decisions.md #3). The subject lives on the exception row, so the spec's
--    case_id is subject_type/subject_id there. Per-fact required fields are
--    checked by governance-domain validate_attestation. Insert-only.
CREATE TABLE governed_exception_attestations (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    exception_id         UUID        NOT NULL,
    fact_date            DATE        NOT NULL,
    evidence_ref         TEXT        NULL CHECK (evidence_ref IS NULL OR char_length(btrim(evidence_ref)) BETWEEN 1 AND 500),
    method_code          TEXT        NULL CHECK (method_code IS NULL OR char_length(btrim(method_code)) BETWEEN 1 AND 100),
    detail_code          TEXT        NULL CHECK (detail_code IS NULL OR char_length(btrim(detail_code)) BETWEEN 1 AND 100),
    new_due_date         DATE        NULL,
    amount_krw           BIGINT      NULL CHECK (amount_krw IS NULL OR amount_krw >= 0),
    reference            TEXT        NULL CHECK (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 200),
    receipt_numbers      TEXT[]      NOT NULL DEFAULT '{}',
    filer                TEXT        NULL CHECK (filer IS NULL OR char_length(btrim(filer)) BETWEEN 1 AND 200),
    attested_by          UUID        NOT NULL,
    step_up_assertion_id UUID        NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, exception_id),
    FOREIGN KEY (exception_id, org_id) REFERENCES governed_exceptions(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (attested_by, org_id)  REFERENCES users(id, org_id) ON DELETE RESTRICT
);

ALTER TABLE governed_exception_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_exception_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON governed_exception_attestations
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_governed_exception_attestations_org_immutable
    BEFORE UPDATE ON governed_exception_attestations
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_governed_exception_attestations_no_update
    BEFORE UPDATE ON governed_exception_attestations
    FOR EACH ROW EXECUTE FUNCTION governance_append_only_record();
CREATE TRIGGER trg_governed_exception_attestations_no_delete
    BEFORE DELETE ON governed_exception_attestations
    FOR EACH ROW EXECUTE FUNCTION governed_exceptions_delete_guard();

REVOKE ALL PRIVILEGES ON governed_exception_attestations FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON governed_exception_attestations TO console_rt;

COMMENT ON TABLE governed_exception_attestations IS 'BW-06/#3 attestation of an offline fact; the exception row holds rule_code = fact code';
COMMENT ON COLUMN governed_exception_attestations.id IS 'pd:none — attestation id';
COMMENT ON COLUMN governed_exception_attestations.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN governed_exception_attestations.exception_id IS 'pd:none — the governed exception this attestation completes';
COMMENT ON COLUMN governed_exception_attestations.fact_date IS 'pd:personal — date of the attested fact about the employee (receipt, delivery, payment, filing)';
COMMENT ON COLUMN governed_exception_attestations.evidence_ref IS 'pd:personal — attachment or document reference for the fact';
COMMENT ON COLUMN governed_exception_attestations.method_code IS 'pd:none — delivery or return method code';
COMMENT ON COLUMN governed_exception_attestations.detail_code IS 'pd:none — statutory exception code (근퇴법 §9②)';
COMMENT ON COLUMN governed_exception_attestations.new_due_date IS 'pd:personal — agreed new payment due date for the employee';
COMMENT ON COLUMN governed_exception_attestations.amount_krw IS 'pd:personal — final pay amount paid to the employee';
COMMENT ON COLUMN governed_exception_attestations.reference IS 'pd:personal — payment or filing reference';
COMMENT ON COLUMN governed_exception_attestations.receipt_numbers IS 'pd:personal — 4대보험 접수번호 per insurer';
COMMENT ON COLUMN governed_exception_attestations.filer IS 'pd:personal — filer identity when no receipt number exists';
COMMENT ON COLUMN governed_exception_attestations.attested_by IS 'pd:personal — user who attested';
COMMENT ON COLUMN governed_exception_attestations.step_up_assertion_id IS 'pd:none — attester step-up; logical ref, no FK';
COMMENT ON COLUMN governed_exception_attestations.created_at IS 'pd:none — attestation time';

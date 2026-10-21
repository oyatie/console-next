-- 인사카드 이력 sections (MR-31): 학력, 자격·면허, 병역, 교육 이수.
--
-- 근로기준법 시행규칙 별지 제16호서식 (근로자 명부) names them under 이력 ›
-- 기타 사항 「필요시 학력, 병역 사항, 기능·자격 사항, 교육 이수 내역 등」.
-- They are facts of the natural person, not of one employment, so an entry
-- hangs off `persons` (0213): two employee records bound to one person show
-- the same entries. The writer mints the person through the Person port when
-- an employee has no binding yet (trunk import does not mint one).
--
-- Lane number (head+1 of trunk 6898d8f5); INTEG renumbers at merge.
-- Writer crate: console-hr-adapter-postgres (module `record`).
--
-- SHAPE. `person_record_entries` is an identity anchor (which person, which
-- section). Every value lives in `person_record_revisions`, append-only:
-- CREATE is version 1, an UPDATE (a correction) or a VOID appends the next
-- version carrying the whole snapshot, so history is the revision list and the
-- current state is MAX(version). Typed columns, one group per section; a CHECK
-- per section requires its own columns and keeps every other group NULL.
--
-- PII MINIMISATION (개인정보 보호법 §16①, §23, §24, 시행령 §19):
--   * 병역 keeps status, branch, rank and dates only. No 면제 사유 and no
--     전역 구분: both can disclose health (§23 민감정보), so there is no
--     column to put them in.
--   * 자격·면허 never stores a 운전면허번호 (고유식별정보, 시행령 §19.3): no
--     number when the kind is DRIVER_LICENSE, and no number of the licence's
--     shape for any kind (12 digits, or a 2-letter Hangul region + 10 digits).
--   * Every free-text column refuses a 주민등록번호/외국인등록번호 shape.
-- The domain refuses all of these first with a coded message; the CHECKs are
-- the backstop for any other writer.
--
-- DELETE is not granted to console_rt: a void keeps history. Erasure (§21) is
-- a definer/purge concern, so the trigger refuses UPDATE only and a DELETE
-- by the owner still works. The organizations FKs are RESTRICT, not CASCADE,
-- so tenant force-remove's catalog sweep (0196/0208,
-- platform_force_remove_direct_org_children, newest table first) clears
-- these rows before `users` (actor FKs are RESTRICT) and `persons` go.
SET LOCAL lock_timeout = '2s';

-- \d{6}-?[1-8]\d{6} not touching another digit (hr-domain `contains_rrn_shaped`).
CREATE FUNCTION person_record_text_ok(value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT value IS NULL
        OR value !~ '(^|[^0-9])[0-9]{6}-?[1-8][0-9]{6}($|[^0-9])'
$$;

-- ---------------------------------------------------------------------------
-- person_record_entries
CREATE TABLE person_record_entries (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    person_id  UUID        NOT NULL,
    section    TEXT        NOT NULL CHECK (section IN ('EDUCATION', 'QUALIFICATION', 'MILITARY', 'TRAINING')),
    created_by UUID        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    -- The revision FK names the section, so a revision cannot change it.
    UNIQUE (org_id, id, section),
    FOREIGN KEY (org_id, person_id) REFERENCES persons (org_id, id),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX person_record_entries_person_idx ON person_record_entries (org_id, person_id, section);

-- ---------------------------------------------------------------------------
-- person_record_revisions
CREATE TABLE person_record_revisions (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    entry_id        UUID        NOT NULL,
    section         TEXT        NOT NULL,
    version         BIGINT      NOT NULL CHECK (version >= 1),
    kind            TEXT        NOT NULL CHECK (kind IN ('CREATE', 'UPDATE', 'VOID')),
    command_id      UUID        NOT NULL,
    payload_digest  BYTEA       NOT NULL CHECK (octet_length(payload_digest) = 32),
    reason          TEXT        NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND person_record_text_ok(reason)),
    source          TEXT        NOT NULL CHECK (source IN ('MANUAL', 'IMPORT')),
    import_batch_id UUID        NULL,
    actor_id        UUID        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 학력
    edu_school      TEXT        NULL CHECK (char_length(edu_school) BETWEEN 1 AND 100 AND person_record_text_ok(edu_school)),
    edu_level       TEXT        NULL CHECK (edu_level IN ('HIGH_SCHOOL', 'ASSOCIATE', 'BACHELOR', 'MASTER', 'DOCTORATE', 'OTHER')),
    edu_major       TEXT        NULL CHECK (char_length(edu_major) BETWEEN 1 AND 100 AND person_record_text_ok(edu_major)),
    edu_status      TEXT        NULL CHECK (edu_status IN ('GRADUATED', 'EXPECTED', 'ENROLLED', 'ON_LEAVE', 'COMPLETED', 'WITHDRAWN')),
    edu_entered_on  DATE        NULL CHECK (EXTRACT(DAY FROM edu_entered_on) = 1),
    edu_ended_on    DATE        NULL CHECK (EXTRACT(DAY FROM edu_ended_on) = 1),
    -- 자격·면허
    qual_name       TEXT        NULL CHECK (char_length(qual_name) BETWEEN 1 AND 100 AND person_record_text_ok(qual_name)),
    qual_kind       TEXT        NULL CHECK (qual_kind IN ('NATIONAL_TECHNICAL', 'NATIONAL_PROFESSIONAL', 'PRIVATE', 'DRIVER_LICENSE', 'FOREIGN', 'OTHER')),
    qual_grade      TEXT        NULL CHECK (char_length(qual_grade) BETWEEN 1 AND 50 AND person_record_text_ok(qual_grade)),
    qual_issuer     TEXT        NULL CHECK (char_length(qual_issuer) BETWEEN 1 AND 100 AND person_record_text_ok(qual_issuer)),
    qual_number     TEXT        NULL CHECK (char_length(qual_number) BETWEEN 1 AND 50 AND person_record_text_ok(qual_number)
                                       AND regexp_replace(qual_number, '[^0-9]', '', 'g') !~ '^[0-9]{12}$'
                                       AND qual_number !~ '[가-힣]{2}\s*[0-9]{2}-?[0-9]{6}-?[0-9]{2}'),
    qual_acquired_on DATE       NULL,
    qual_expires_on DATE        NULL,
    -- 병역
    mil_status      TEXT        NULL CHECK (mil_status IN ('COMPLETED', 'SERVING', 'NOT_COMPLETED', 'EXEMPT', 'NOT_APPLICABLE')),
    mil_branch      TEXT        NULL CHECK (mil_branch IN ('ARMY', 'NAVY', 'AIR_FORCE', 'MARINE_CORPS', 'SOCIAL_SERVICE', 'ALTERNATIVE', 'OTHER')),
    mil_rank        TEXT        NULL CHECK (char_length(mil_rank) BETWEEN 1 AND 30 AND person_record_text_ok(mil_rank)),
    mil_served_from DATE        NULL,
    mil_served_to   DATE        NULL,
    -- 교육 이수
    trn_course      TEXT        NULL CHECK (char_length(trn_course) BETWEEN 1 AND 100 AND person_record_text_ok(trn_course)),
    trn_provider    TEXT        NULL CHECK (char_length(trn_provider) BETWEEN 1 AND 100 AND person_record_text_ok(trn_provider)),
    trn_status      TEXT        NULL CHECK (trn_status IN ('COMPLETED', 'IN_PROGRESS', 'NOT_COMPLETED')),
    trn_started_on  DATE        NULL,
    trn_ended_on    DATE        NULL,
    trn_hours       INTEGER     NULL CHECK (trn_hours BETWEEN 1 AND 9999),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id),
    UNIQUE (org_id, entry_id, version),
    FOREIGN KEY (org_id, entry_id, section) REFERENCES person_record_entries (org_id, id, section),
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT person_record_revisions_void_reason CHECK (kind <> 'VOID' OR reason IS NOT NULL),
    CONSTRAINT person_record_revisions_first CHECK ((version = 1) = (kind = 'CREATE')),
    CONSTRAINT person_record_revisions_import CHECK ((source = 'IMPORT') = (import_batch_id IS NOT NULL)),
    CONSTRAINT person_record_revisions_education CHECK (
        (section = 'EDUCATION') = (edu_school IS NOT NULL AND edu_level IS NOT NULL AND edu_status IS NOT NULL)
        AND (section = 'EDUCATION' OR (edu_major IS NULL AND edu_entered_on IS NULL AND edu_ended_on IS NULL))
        AND (edu_ended_on IS NULL OR edu_entered_on IS NULL OR edu_ended_on >= edu_entered_on)),
    CONSTRAINT person_record_revisions_qualification CHECK (
        (section = 'QUALIFICATION') = (qual_name IS NOT NULL AND qual_kind IS NOT NULL)
        AND (section = 'QUALIFICATION' OR (qual_grade IS NULL AND qual_issuer IS NULL AND qual_number IS NULL
                                           AND qual_acquired_on IS NULL AND qual_expires_on IS NULL))
        AND (qual_kind IS DISTINCT FROM 'DRIVER_LICENSE' OR qual_number IS NULL)
        AND (qual_expires_on IS NULL OR qual_acquired_on IS NULL OR qual_expires_on >= qual_acquired_on)),
    CONSTRAINT person_record_revisions_military CHECK (
        (section = 'MILITARY') = (mil_status IS NOT NULL)
        AND (mil_status IN ('COMPLETED', 'SERVING')
             OR (mil_branch IS NULL AND mil_rank IS NULL AND mil_served_from IS NULL AND mil_served_to IS NULL))
        AND (mil_served_to IS NULL OR mil_served_from IS NULL OR mil_served_to >= mil_served_from)),
    CONSTRAINT person_record_revisions_training CHECK (
        (section = 'TRAINING') = (trn_course IS NOT NULL AND trn_status IS NOT NULL AND trn_started_on IS NOT NULL)
        AND (section = 'TRAINING' OR (trn_provider IS NULL AND trn_ended_on IS NULL AND trn_hours IS NULL))
        AND (trn_ended_on IS NULL OR trn_ended_on >= trn_started_on))
);
CREATE INDEX person_record_revisions_batch_idx ON person_record_revisions (org_id, import_batch_id)
    WHERE import_batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- person_record_import_batches: one applied per-section import sheet, so a
-- replayed Idempotency-Key answers with the stored report. The report holds
-- row numbers, outcomes, codes and entry ids only, never field values.
CREATE TABLE person_record_import_batches (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    command_id  UUID        NOT NULL,
    section     TEXT        NOT NULL CHECK (section IN ('EDUCATION', 'QUALIFICATION', 'MILITARY', 'TRAINING')),
    plan_digest BYTEA       NOT NULL CHECK (octet_length(plan_digest) = 32),
    report      JSONB       NOT NULL CHECK (jsonb_typeof(report) = 'object'),
    actor_id    UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, command_id),
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- Append-only: UPDATE is refused on all three tables.
CREATE FUNCTION person_record_row_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'person record table %: UPDATE is refused, the row is immutable', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER trg_person_record_entries_immutable BEFORE UPDATE ON person_record_entries
    FOR EACH ROW EXECUTE FUNCTION person_record_row_immutable();
CREATE TRIGGER trg_person_record_revisions_immutable BEFORE UPDATE ON person_record_revisions
    FOR EACH ROW EXECUTE FUNCTION person_record_row_immutable();
CREATE TRIGGER trg_person_record_import_batches_immutable BEFORE UPDATE ON person_record_import_batches
    FOR EACH ROW EXECUTE FUNCTION person_record_row_immutable();

-- RLS: ENABLE and FORCE, org_isolation.
ALTER TABLE person_record_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_record_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON person_record_entries
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
ALTER TABLE person_record_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_record_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON person_record_revisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
ALTER TABLE person_record_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_record_import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON person_record_import_batches
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL PRIVILEGES ON person_record_entries FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON person_record_entries TO console_rt;
REVOKE ALL PRIVILEGES ON person_record_revisions FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON person_record_revisions TO console_rt;
REVOKE ALL PRIVILEGES ON person_record_import_batches FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON person_record_import_batches TO console_rt;

-- ---------------------------------------------------------------------------
-- Classification.
COMMENT ON TABLE person_record_entries IS '인사카드 이력 section entry (학력/자격·면허/병역/교육 이수) of a person; values live in person_record_revisions';
COMMENT ON COLUMN person_record_entries.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN person_record_entries.id IS 'pd:none — entry id';
COMMENT ON COLUMN person_record_entries.person_id IS 'pd:personal — the natural person';
COMMENT ON COLUMN person_record_entries.section IS 'pd:none — EDUCATION | QUALIFICATION | MILITARY | TRAINING';
COMMENT ON COLUMN person_record_entries.created_by IS 'pd:personal — user who created the entry';
COMMENT ON COLUMN person_record_entries.created_at IS 'pd:none — row creation time';

COMMENT ON TABLE person_record_revisions IS 'Append-only history of one 인사카드 entry; the latest version is current, VOID hides it';
COMMENT ON COLUMN person_record_revisions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN person_record_revisions.id IS 'pd:none — revision id';
COMMENT ON COLUMN person_record_revisions.entry_id IS 'pd:none — the entry';
COMMENT ON COLUMN person_record_revisions.section IS 'pd:none — the entry''s section (pinned by FK)';
COMMENT ON COLUMN person_record_revisions.version IS 'pd:none — 1 = CREATE, then +1 per UPDATE or VOID';
COMMENT ON COLUMN person_record_revisions.kind IS 'pd:none — CREATE | UPDATE | VOID';
COMMENT ON COLUMN person_record_revisions.command_id IS 'pd:none — the accepted command (Idempotency-Key) that wrote the row';
COMMENT ON COLUMN person_record_revisions.payload_digest IS 'pd:none — SHA-256 of the accepted command payload';
COMMENT ON COLUMN person_record_revisions.reason IS 'pd:personal — why the entry was corrected or voided';
COMMENT ON COLUMN person_record_revisions.source IS 'pd:none — MANUAL | IMPORT';
COMMENT ON COLUMN person_record_revisions.import_batch_id IS 'pd:none — the import sheet batch (IMPORT only)';
COMMENT ON COLUMN person_record_revisions.actor_id IS 'pd:personal — user who wrote the revision';
COMMENT ON COLUMN person_record_revisions.created_at IS 'pd:none — row creation time';
COMMENT ON COLUMN person_record_revisions.edu_school IS 'pd:personal — 학력: school name';
COMMENT ON COLUMN person_record_revisions.edu_level IS 'pd:personal — 학력: level';
COMMENT ON COLUMN person_record_revisions.edu_major IS 'pd:personal — 학력: major';
COMMENT ON COLUMN person_record_revisions.edu_status IS 'pd:personal — 학력: graduation status';
COMMENT ON COLUMN person_record_revisions.edu_entered_on IS 'pd:personal — 학력: entry month (first day)';
COMMENT ON COLUMN person_record_revisions.edu_ended_on IS 'pd:personal — 학력: end month (first day)';
COMMENT ON COLUMN person_record_revisions.qual_name IS 'pd:personal — 자격·면허: name';
COMMENT ON COLUMN person_record_revisions.qual_kind IS 'pd:personal — 자격·면허: kind';
COMMENT ON COLUMN person_record_revisions.qual_grade IS 'pd:personal — 자격·면허: grade or class';
COMMENT ON COLUMN person_record_revisions.qual_issuer IS 'pd:personal — 자격·면허: issuer';
COMMENT ON COLUMN person_record_revisions.qual_number IS 'pd:personal — 자격·면허: certificate number; never a 운전면허번호';
COMMENT ON COLUMN person_record_revisions.qual_acquired_on IS 'pd:personal — 자격·면허: acquired on';
COMMENT ON COLUMN person_record_revisions.qual_expires_on IS 'pd:personal — 자격·면허: expires on';
COMMENT ON COLUMN person_record_revisions.mil_status IS 'pd:personal — 병역: status (no 면제 사유 is stored)';
COMMENT ON COLUMN person_record_revisions.mil_branch IS 'pd:personal — 병역: branch';
COMMENT ON COLUMN person_record_revisions.mil_rank IS 'pd:personal — 병역: rank';
COMMENT ON COLUMN person_record_revisions.mil_served_from IS 'pd:personal — 병역: service start';
COMMENT ON COLUMN person_record_revisions.mil_served_to IS 'pd:personal — 병역: service end';
COMMENT ON COLUMN person_record_revisions.trn_course IS 'pd:personal — 교육 이수: course';
COMMENT ON COLUMN person_record_revisions.trn_provider IS 'pd:personal — 교육 이수: provider';
COMMENT ON COLUMN person_record_revisions.trn_status IS 'pd:personal — 교육 이수: completion status';
COMMENT ON COLUMN person_record_revisions.trn_started_on IS 'pd:personal — 교육 이수: start';
COMMENT ON COLUMN person_record_revisions.trn_ended_on IS 'pd:personal — 교육 이수: end';
COMMENT ON COLUMN person_record_revisions.trn_hours IS 'pd:personal — 교육 이수: hours';

COMMENT ON TABLE person_record_import_batches IS 'One applied 인사카드 section import sheet; the report replays a repeated Idempotency-Key';
COMMENT ON COLUMN person_record_import_batches.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN person_record_import_batches.command_id IS 'pd:none — the Idempotency-Key of the apply';
COMMENT ON COLUMN person_record_import_batches.section IS 'pd:none — the section imported';
COMMENT ON COLUMN person_record_import_batches.plan_digest IS 'pd:none — SHA-256 of the previewed plan the apply was bound to';
COMMENT ON COLUMN person_record_import_batches.report IS 'pd:personal — per-row outcome, code and entry id; no field values';
COMMENT ON COLUMN person_record_import_batches.actor_id IS 'pd:personal — user who applied the sheet';
COMMENT ON COLUMN person_record_import_batches.created_at IS 'pd:none — row creation time';

-- ---------------------------------------------------------------------------
-- Register the four section switches (hr.record.<section>.enabled, bool,
-- tenant, default true) with the settings trigger. setting_definition() is
-- regenerated whole from the key roster (crates/settings/domain/tests/
-- sql_definitions.rs now pins this file); the trigger and setting_ordinal()
-- call it by name at run time, so the drop is safe. INTEG: if another lane
-- added keys first, regenerate this block once more at the merge.
DROP FUNCTION setting_definition(TEXT);

-- BEGIN GENERATED by console-settings-domain tests/sql_definitions.rs
CREATE FUNCTION setting_definition(
    p_key TEXT,
    OUT kind TEXT,
    OUT min_value BIGINT,
    OUT max_value BIGINT,
    OUT default_ordinal BIGINT,
    OUT looser_when TEXT,
    OUT governance TEXT,
    OUT codes TEXT[]
)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT d.kind, d.min_value, d.max_value, d.default_ordinal, d.looser_when, d.governance, d.codes
    FROM (VALUES
        ('approval.overdue.escalate_after_business_days', 'int', 1::BIGINT, NULL::BIGINT, 2::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.delegation.max_days', 'int', 1::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.returned.reminder_days', 'int', 1::BIGINT, NULL::BIGINT, 3::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.doc_class.registered_branch_change.requires_governing_body_decision', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'fixed', NULL::TEXT[]),
        ('approval.doc_class.registered_manager_appointment.requires_governing_body_decision', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'fixed', NULL::TEXT[]),
        ('corporate.small_company_383_proviso', 'bool', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date.backdate_soft_days', 'int', 3::BIGINT, 14::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date.future_soft_days', 'int', 30::BIGINT, 365::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date_unknown.resolve_days', 'int', 1::BIGINT, 14::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.hq_review.lead_days', 'int', 1::BIGINT, 30::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('exit.hq_review.post_apply_days', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.access.revoke_mode.voluntary', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['ON_CONFIRM', 'END_OF_EXIT_DATE']::TEXT[]),
        ('exit.access.revoke_mode.involuntary', 'code', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', ARRAY['ON_CONFIRM', 'END_OF_EXIT_DATE']::TEXT[]),
        ('exit.access.handover_max_days', 'int', 0::BIGINT, 30::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.access.self_service_days', 'int', 30::BIGINT, 1095::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.settlement.wage_deviation_pct', 'int', 0::BIGINT, 10::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('lifecycle.backdate_soft_floor_days', 'int', 0::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exceptions.approval_ttl_days', 'int', 1::BIGINT, 30::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('withholding.filing_cadence', 'code', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'neutral', 'tenant', ARRAY['MONTHLY', 'SEMIANNUAL']::TEXT[]),
        ('period_lock.unlock_max_days', 'int', 1::BIGINT, 14::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('auth.idle_timeout_minutes', 'int', 5::BIGINT, 60::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('authz.sole_holder.mode', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['refuse', 'step_up_notice_review']::TEXT[]),
        ('authz.elevated_grant.sole_admin_delay', 'int', 24::BIGINT, 168::BIGINT, 24::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.second_person.min_grant_age', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.second_person.response_due', 'int', 1::BIGINT, 120::BIGINT, 48::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('security_contact.reverify_interval', 'int', 1::BIGINT, 12::BIGINT, 12::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('review.sole_holder_exception.due', 'int', 1::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('audit.permission_change.retention', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('audit.access_log.retention', 'int', 2::BIGINT, NULL::BIGINT, 2::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.cooling_period', 'int', 3::BIGINT, NULL::BIGINT, 7::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.retrieval_window', 'int', 30::BIGINT, NULL::BIGINT, 60::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.destroy_after_due', 'int', 0::BIGINT, 5::BIGINT, 5::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('offboarding.archive_service.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('backup.archive_tail', 'int', NULL::BIGINT, NULL::BIGINT, 35::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('privacy.exit_processing_overdue_after', 'int', 1::BIGINT, 180::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('retention.labor.employee_register', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.employment_contract', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.wage_ledger', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.wage_basis', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.hire_exit', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.promotion_pay_change', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.leave', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.written_agreements', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.minor_proof', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.tax.books_evidence', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.nhis.employer_docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.nps.member_notice_proof', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.equality.docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.equality.grievance', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.severance.interim_proof', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.safety.docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.recruiting.docs', 'int', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('hr.record.education.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.qualification.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.military.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.training.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

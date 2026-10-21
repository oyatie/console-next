-- MR-34 (EMP-FACTS): 인적사항 extras HR keeps on an employee — 한자 · 영문
-- 성명, 국적, 개인 메일, 비상연락처, 사진 and 그룹 입사일 (근속 기산일).
--
-- None is a 근로자 명부 item (근로기준법 시행령 §20, MST 270551): they are
-- optional company fields. NULL = 미입력, never defaulted (개인정보 보호법
-- §16① minimisation). 비상연락처 is a third person's data,
-- kept to three rows. No 주민등록번호 / 외국인등록번호 / 여권번호 /
-- 운전면허번호 value is stored (§24, §24조의2): 영문 성명 is a name, not a
-- passport number.
--
-- 1. employee_photo_uploads: one row per presigned upload of a 사진. The
--    object lives in object storage under a server-made, org-prefixed key;
--    confirmed_at is set once the object is seen at the declared size. A
--    replaced photo's row stays (the ledger names it).
-- 2. employee_personal_facts: one row per employee; photo_upload_id points
--    at a confirmed upload. group_service_start_date (그룹 입사일) counts
--    toward 계속근로기간 (근기법 §60, 근퇴법 §8); the application keeps it on
--    or before the 입사일.
-- 3. employee_emergency_contacts: 비상연락처 rows. A correction replaces the
--    live list: old rows are voided (kept), new ones inserted.
-- 4. employee_corrections.field admits the seven items beside MR-8's and
--    MR-23's, so every change is one ledger row.
--
-- No seed rows. Numbered head+1 of the lane's stack (0268, MR-23); INTEG
-- renumbers it and unions the field CHECK with any later widening.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. employee_photo_uploads
CREATE TABLE employee_photo_uploads (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id           UUID        NOT NULL,
    employee_id  UUID        NOT NULL,
    object_key   TEXT        NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 300),
    content_type TEXT        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    byte_size    INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
    issued_by    UUID        NOT NULL,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (object_key),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (issued_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX employee_photo_uploads_employee_idx ON employee_photo_uploads (org_id, employee_id);

-- ---------------------------------------------------------------------------
-- 2. employee_personal_facts
CREATE TABLE employee_personal_facts (
    org_id                   UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id              UUID        NOT NULL,
    name_hanja               TEXT        NULL
        CHECK (name_hanja IS NULL OR (btrim(name_hanja) = name_hanja AND char_length(name_hanja) BETWEEN 1 AND 30)),
    name_en                  TEXT        NULL
        CHECK (name_en IS NULL OR (btrim(name_en) = name_en AND char_length(name_en) BETWEEN 1 AND 100)),
    nationality              TEXT        NULL CHECK (nationality IS NULL OR nationality ~ '^[A-Z]{2}$'),
    personal_email           TEXT        NULL CHECK (personal_email IS NULL OR (
        char_length(personal_email) BETWEEN 3 AND 254
        AND personal_email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
    photo_upload_id          UUID        NULL,
    group_service_start_date DATE        NULL CHECK (group_service_start_date IS NULL OR group_service_start_date >= DATE '1900-01-01'),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, employee_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, photo_upload_id) REFERENCES employee_photo_uploads (org_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 3. employee_emergency_contacts
CREATE TABLE employee_emergency_contacts (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id UUID        NOT NULL,
    seq         SMALLINT    NOT NULL CHECK (seq BETWEEN 1 AND 3),
    name        TEXT        NOT NULL CHECK (btrim(name) = name AND char_length(name) BETWEEN 1 AND 50),
    relation    TEXT        NOT NULL CHECK (relation IN ('SPOUSE', 'PARENT', 'CHILD', 'SIBLING', 'RELATIVE', 'OTHER')),
    phone_e164  TEXT        NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    voided_at   TIMESTAMPTZ NULL,
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX employee_emergency_contacts_live_seq_key
    ON employee_emergency_contacts (org_id, employee_id, seq) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. The ledger admits the 인적사항 items (MR-8 + MR-23 + these seven).
ALTER TABLE employee_corrections DROP CONSTRAINT employee_corrections_field_check;
ALTER TABLE employee_corrections ADD CONSTRAINT employee_corrections_field_check CHECK (field IN (
    'name', 'phone', 'job', 'work_email', 'id_type',
    'hire_date', 'exit_date', 'birth_date', 'employee_number',
    'employment_type', 'base_pay', 'pay_unit', 'probation_end_date',
    'position_id',
    -- IMPORT (MR-7) ledger rows; INTEG keeps the union with 0283.
    'position', 'worksite_name', 'worksite_address',
    'sex', 'address', 'careers', 'exit_reason', 'register_note',
    'name_hanja', 'name_en', 'nationality', 'personal_email',
    'emergency_contacts', 'photo', 'group_service_start_date'
));

-- ---------------------------------------------------------------------------
-- RLS, grants (no DELETE: history stays; the 3-year purge is MR-26's)
ALTER TABLE employee_photo_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_photo_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_photo_uploads
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_photo_uploads_org_immutable BEFORE UPDATE ON employee_photo_uploads
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_personal_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_personal_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_personal_facts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_personal_facts_org_immutable BEFORE UPDATE ON employee_personal_facts
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_emergency_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_emergency_contacts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_emergency_contacts_org_immutable BEFORE UPDATE ON employee_emergency_contacts
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

REVOKE ALL PRIVILEGES ON employee_photo_uploads, employee_personal_facts, employee_emergency_contacts
    FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON employee_photo_uploads, employee_personal_facts, employee_emergency_contacts
    TO console_rt;
GRANT UPDATE (confirmed_at) ON employee_photo_uploads TO console_rt;
GRANT UPDATE (name_hanja, name_en, nationality, personal_email, photo_upload_id,
              group_service_start_date, updated_at)
    ON employee_personal_facts TO console_rt;
GRANT UPDATE (voided_at) ON employee_emergency_contacts TO console_rt;

-- ---------------------------------------------------------------------------
-- Classification
COMMENT ON TABLE employee_photo_uploads IS 'MR-34 사진 uploads (object storage, presigned); a row per issued upload';
COMMENT ON COLUMN employee_photo_uploads.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_photo_uploads.id IS 'pd:none — upload id (the photo correction value)';
COMMENT ON COLUMN employee_photo_uploads.employee_id IS 'pd:personal — whose photo; row is a natural person';
COMMENT ON COLUMN employee_photo_uploads.object_key IS 'pd:personal — object-storage key of the photo (a face image)';
COMMENT ON COLUMN employee_photo_uploads.content_type IS 'pd:none — image/jpeg | image/png | image/webp';
COMMENT ON COLUMN employee_photo_uploads.byte_size IS 'pd:none — declared and confirmed size';
COMMENT ON COLUMN employee_photo_uploads.issued_by IS 'pd:personal — user who started the upload';
COMMENT ON COLUMN employee_photo_uploads.issued_at IS 'pd:none — when the upload was issued';
COMMENT ON COLUMN employee_photo_uploads.confirmed_at IS 'pd:none — when the object was seen in storage; NULL = not uploaded';

COMMENT ON TABLE employee_personal_facts IS 'MR-34 인적사항 extras (optional, not 명부 items); NULL = 미입력';
COMMENT ON COLUMN employee_personal_facts.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_personal_facts.employee_id IS 'pd:personal — the employee; row is a natural person';
COMMENT ON COLUMN employee_personal_facts.name_hanja IS 'pd:personal — 한자 성명';
COMMENT ON COLUMN employee_personal_facts.name_en IS 'pd:personal — 영문 성명 (a name, never a passport number)';
COMMENT ON COLUMN employee_personal_facts.nationality IS 'pd:personal — 국적, ISO 3166-1 alpha-2';
COMMENT ON COLUMN employee_personal_facts.personal_email IS 'pd:personal — 개인 메일';
COMMENT ON COLUMN employee_personal_facts.photo_upload_id IS 'pd:personal — current 사진, a confirmed employee_photo_uploads row';
COMMENT ON COLUMN employee_personal_facts.group_service_start_date IS 'pd:personal — 그룹 입사일 (근속 기산일)';
COMMENT ON COLUMN employee_personal_facts.updated_at IS 'pd:none — last change';

COMMENT ON TABLE employee_emergency_contacts IS 'MR-34 비상연락처 (third-party data, at most 3 live rows); a correction voids the live rows and inserts the new list';
COMMENT ON COLUMN employee_emergency_contacts.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_emergency_contacts.id IS 'pd:none — row id';
COMMENT ON COLUMN employee_emergency_contacts.employee_id IS 'pd:personal — whose contact; row is a natural person';
COMMENT ON COLUMN employee_emergency_contacts.seq IS 'pd:none — order within the list';
COMMENT ON COLUMN employee_emergency_contacts.name IS 'pd:personal — the contact person''s name (third party)';
COMMENT ON COLUMN employee_emergency_contacts.relation IS 'pd:personal — relation to the employee';
COMMENT ON COLUMN employee_emergency_contacts.phone_e164 IS 'pd:personal — the contact person''s phone (third party)';
COMMENT ON COLUMN employee_emergency_contacts.voided_at IS 'pd:none — replaced by a later correction';
COMMENT ON COLUMN employee_emergency_contacts.created_by IS 'pd:personal — user who recorded the row';
COMMENT ON COLUMN employee_emergency_contacts.created_at IS 'pd:none — when the row was recorded';

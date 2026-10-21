-- 사업자등록증 and other entity evidence, kept as uploaded (entity-depth design §5;
-- prealpha-gate U2; lane corrections #10: no extraction, no 국세청 check).
--
-- Lane number (head+1 of hard/entity-depth b75b0a1); INTEG renumbers at merge.
--
-- The admin types every field; the original is attached to the 법인 or the
-- 사업자등록 it backs and kept as evidence under the setting
-- `retention.entity_registration_document` (default P5Y after it is
-- superseded, 국세기본법 §85의3②). `superseded_at` is set once, when a newer
-- certificate of the same kind is attached to the same record; the retention
-- clock runs from then. Disposition (the purge) belongs to GOV-AUD RET-1..3:
-- console_rt gets no DELETE here.
--
-- ponytail: the bytes live in this row (BYTEA, ≤ 10 MiB, TOASTed, backed up
-- with Postgres, atomic with the link). Move to the S3 evidence store
-- (platform/storage) if documents outgrow a few per tenant.
--
-- No seed rows. Writer crate: console-entity-adapter-postgres.
SET LOCAL lock_timeout = '2s';

CREATE TABLE entity_documents (
    org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id               UUID        NOT NULL DEFAULT gen_random_uuid(),
    kind             TEXT        NOT NULL CHECK (kind IN ('BIZ_REG_CERT', 'CORP_REGISTRY_EXTRACT', 'INSURANCE_NOTICE', 'OTHER')),
    file_name        TEXT        NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 255),
    content_type     TEXT        NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    byte_size        INTEGER     NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
    sha256           BYTEA       NOT NULL CHECK (octet_length(sha256) = 32),
    content          BYTEA       NOT NULL CHECK (octet_length(content) = byte_size),
    retention_key    TEXT        NOT NULL CHECK (retention_key = 'retention.entity_registration_document'),
    legal_entity_id  UUID        NULL,
    registration_id  UUID        NULL,
    issued_on        DATE        NULL,
    superseded_at    TIMESTAMPTZ NULL,
    uploaded_by      UUID        NOT NULL,
    uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    -- The same file uploaded twice is one document (the upload is idempotent).
    UNIQUE (org_id, sha256, kind),
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, registration_id) REFERENCES business_registrations (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (uploaded_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT entity_documents_registration_needs_entity CHECK (registration_id IS NULL OR legal_entity_id IS NOT NULL),
    CONSTRAINT entity_documents_superseded_needs_link CHECK (superseded_at IS NULL OR legal_entity_id IS NOT NULL)
);
CREATE INDEX entity_documents_entity_idx ON entity_documents (org_id, legal_entity_id);
CREATE INDEX entity_documents_registration_idx ON entity_documents (org_id, registration_id);

-- A document is attached once (never moved to another record), and its bytes,
-- kind and uploader never change.
CREATE FUNCTION entity_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'entity document % is kept as evidence; disposition belongs to the retention job', OLD.id;
    END IF;
    IF (NEW.org_id, NEW.id, NEW.kind, NEW.file_name, NEW.content_type, NEW.byte_size, NEW.sha256, NEW.retention_key,
        NEW.uploaded_by, NEW.uploaded_at)
       IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.kind, OLD.file_name, OLD.content_type, OLD.byte_size, OLD.sha256,
                         OLD.retention_key, OLD.uploaded_by, OLD.uploaded_at)
       OR NEW.content IS DISTINCT FROM OLD.content THEN
        RAISE EXCEPTION 'entity document % is immutable evidence', OLD.id;
    END IF;
    IF (OLD.legal_entity_id IS NOT NULL AND NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id)
       OR (OLD.registration_id IS NOT NULL AND NEW.registration_id IS DISTINCT FROM OLD.registration_id)
       OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
        RAISE EXCEPTION 'entity document % is already attached (document_attached_elsewhere)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE entity_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON entity_documents
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_entity_documents_org_immutable BEFORE UPDATE ON entity_documents
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_entity_documents_guard BEFORE UPDATE OR DELETE ON entity_documents
    FOR EACH ROW EXECUTE FUNCTION entity_documents_guard();
REVOKE ALL PRIVILEGES ON entity_documents FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON entity_documents TO console_rt;
GRANT UPDATE (legal_entity_id, registration_id, issued_on, superseded_at) ON entity_documents TO console_rt;
COMMENT ON TABLE entity_documents IS '사업자등록증 / 등기사항전부증명서 / 공단 통지서 originals kept as tenant evidence (retention.entity_registration_document)';
COMMENT ON COLUMN entity_documents.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN entity_documents.id IS 'pd:none — row id';
COMMENT ON COLUMN entity_documents.kind IS 'pd:none — BIZ_REG_CERT | CORP_REGISTRY_EXTRACT | INSURANCE_NOTICE | OTHER';
COMMENT ON COLUMN entity_documents.file_name IS 'pd:personal — the uploaded file name (may carry a representative''s name)';
COMMENT ON COLUMN entity_documents.content_type IS 'pd:none — application/pdf | image/jpeg | image/png (checked against the bytes)';
COMMENT ON COLUMN entity_documents.byte_size IS 'pd:none — size in bytes (≤ 10 MiB)';
COMMENT ON COLUMN entity_documents.sha256 IS 'pd:none — SHA-256 of the bytes (fixity; one row per file and kind)';
COMMENT ON COLUMN entity_documents.content IS 'pd:personal — the original as uploaded (대표자 성명, 개인사업자 생년월일 as printed)';
COMMENT ON COLUMN entity_documents.retention_key IS 'pd:none — the settings key whose period runs from superseded_at';
COMMENT ON COLUMN entity_documents.legal_entity_id IS 'pd:none — the 법인 this evidence backs; NULL until attached';
COMMENT ON COLUMN entity_documents.registration_id IS 'pd:none — the 사업자등록 this certificate backs; NULL for entity-level evidence';
COMMENT ON COLUMN entity_documents.issued_on IS 'pd:none — 발급일 as typed on the record it backs';
COMMENT ON COLUMN entity_documents.superseded_at IS 'pd:none — when a newer document of the same kind replaced it on the same record; the retention clock starts here';
COMMENT ON COLUMN entity_documents.uploaded_by IS 'pd:personal — user who uploaded it';
COMMENT ON COLUMN entity_documents.uploaded_at IS 'pd:none — upload time';

-- Expand only; released migrations are immutable.
-- 등록증 재발급·정정: a registration revision names the certificate it was
-- recorded from. Nullable (earlier revisions and the N-1 binary write none).
SET LOCAL lock_timeout = '2s';

ALTER TABLE business_registration_revisions
    ADD COLUMN evidence_document_id UUID;

ALTER TABLE business_registration_revisions
    ADD CONSTRAINT business_registration_revisions_evidence_fk
    FOREIGN KEY (org_id, evidence_document_id) REFERENCES entity_documents (org_id, id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE business_registration_revisions
    VALIDATE CONSTRAINT business_registration_revisions_evidence_fk;

COMMENT ON COLUMN business_registration_revisions.evidence_document_id IS 'pd:none — the kept 사업자등록증 original this revision was recorded from';

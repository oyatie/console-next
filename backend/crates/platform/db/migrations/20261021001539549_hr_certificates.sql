-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only. An issued snapshot is append-only; voiding preserves its number.
SET LOCAL lock_timeout = '2s';
CREATE TABLE hr_certificates (
 org_id UUID NOT NULL REFERENCES organizations(id),
 id UUID NOT NULL DEFAULT gen_random_uuid(),
 employee_id UUID NOT NULL,
 certificate_year INTEGER NOT NULL CHECK(certificate_year BETWEEN 1900 AND 9999),
 seq BIGINT NOT NULL CHECK(seq>0),
 certificate_no TEXT NOT NULL CHECK(char_length(certificate_no) BETWEEN 1 AND 70),
 kind TEXT NOT NULL CHECK(kind IN ('EMPLOYMENT','CAREER','EXIT')),
 items TEXT[] NOT NULL CHECK(cardinality(items) BETWEEN 1 AND 5 AND items <@ ARRAY['period','duty','position','wage','birth']::text[]),
 purpose TEXT NOT NULL CHECK(char_length(btrim(purpose)) BETWEEN 1 AND 200),
 snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 replaces_id UUID NULL,
 issued_by UUID NOT NULL,
 issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 voided_at TIMESTAMPTZ NULL,
 voided_by UUID NULL,
 void_reason TEXT NULL CHECK(char_length(btrim(void_reason)) BETWEEN 1 AND 1000),
 PRIMARY KEY(org_id,id),
 UNIQUE(org_id,certificate_year,seq), UNIQUE(org_id,certificate_no), UNIQUE(org_id,replaces_id),
 FOREIGN KEY(employee_id,org_id) REFERENCES employees(id,org_id),
 FOREIGN KEY(issued_by,org_id) REFERENCES users(id,org_id),
 FOREIGN KEY(voided_by,org_id) REFERENCES users(id,org_id),
 FOREIGN KEY(org_id,replaces_id) REFERENCES hr_certificates(org_id,id),
 CHECK(replaces_id IS NULL OR replaces_id<>id),
 CHECK((voided_at IS NULL)=(voided_by IS NULL) AND (voided_at IS NULL)=(void_reason IS NULL))
);
CREATE INDEX hr_certificates_register_idx ON hr_certificates(org_id,issued_at DESC,id DESC);
CREATE INDEX hr_certificates_employee_idx ON hr_certificates(org_id,employee_id,issued_at DESC,id DESC);
ALTER TABLE hr_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON hr_certificates USING(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid) WITH CHECK(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
CREATE TRIGGER trg_hr_certificates_org_immutable BEFORE UPDATE ON hr_certificates FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
GRANT SELECT,INSERT ON hr_certificates TO console_rt;
GRANT UPDATE(voided_at,voided_by,void_reason) ON hr_certificates TO console_rt;
COMMENT ON TABLE hr_certificates IS 'Employment certificate register; immutable requested-fact snapshots and linked replacements';
COMMENT ON COLUMN hr_certificates.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN hr_certificates.id IS 'pd:none — certificate id';
COMMENT ON COLUMN hr_certificates.employee_id IS 'pd:personal — subject employee';
COMMENT ON COLUMN hr_certificates.certificate_year IS 'pd:none — KST issue year';
COMMENT ON COLUMN hr_certificates.seq IS 'pd:none — never reused sequence';
COMMENT ON COLUMN hr_certificates.certificate_no IS 'pd:none — issue number';
COMMENT ON COLUMN hr_certificates.kind IS 'pd:none — certificate kind';
COMMENT ON COLUMN hr_certificates.items IS 'pd:none — expressly requested fields';
COMMENT ON COLUMN hr_certificates.purpose IS 'pd:personal — declared submission purpose';
COMMENT ON COLUMN hr_certificates.snapshot IS 'pd:personal — issued requested facts only; birth and pay only on express request';
COMMENT ON COLUMN hr_certificates.replaces_id IS 'pd:none — original certificate id';
COMMENT ON COLUMN hr_certificates.issued_by IS 'pd:personal — issuer';
COMMENT ON COLUMN hr_certificates.issued_at IS 'pd:none — issuance time';
COMMENT ON COLUMN hr_certificates.voided_at IS 'pd:none — void time';
COMMENT ON COLUMN hr_certificates.voided_by IS 'pd:personal — void actor';
COMMENT ON COLUMN hr_certificates.void_reason IS 'pd:personal — void reason';

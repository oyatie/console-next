-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; configured facts have no guessed tenant defaults.
SET LOCAL lock_timeout = '2s';
CREATE TABLE hr_certificate_settings (
 org_id UUID PRIMARY KEY REFERENCES organizations(id),
 issuer_name TEXT NOT NULL CHECK(char_length(btrim(issuer_name)) BETWEEN 1 AND 200),
 prefix TEXT NOT NULL CHECK(char_length(btrim(prefix)) BETWEEN 1 AND 40),
 width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 12),
 seal_text TEXT NOT NULL CHECK(char_length(btrim(seal_text)) BETWEEN 1 AND 200),
 seal_png TEXT NULL CHECK(seal_png IS NULL OR (seal_png LIKE 'data:image/png;base64,%' AND octet_length(seal_png)<=349550)),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by UUID NOT NULL,
 FOREIGN KEY(updated_by,org_id) REFERENCES users(id,org_id)
);
ALTER TABLE hr_certificate_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_certificate_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON hr_certificate_settings USING(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid) WITH CHECK(org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
CREATE TRIGGER trg_hr_certificate_settings_org_immutable BEFORE UPDATE ON hr_certificate_settings FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
GRANT SELECT,INSERT ON hr_certificate_settings TO console_rt;
GRANT UPDATE(issuer_name,prefix,width,seal_text,seal_png,version,updated_by) ON hr_certificate_settings TO console_rt;
COMMENT ON TABLE hr_certificate_settings IS 'Certificate numbering and issuer seal declared by the tenant';
COMMENT ON COLUMN hr_certificate_settings.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN hr_certificate_settings.prefix IS 'pd:none — configured number prefix';
COMMENT ON COLUMN hr_certificate_settings.width IS 'pd:none — number sequence width';
COMMENT ON COLUMN hr_certificate_settings.seal_text IS 'pd:personal — declared issuer and representative seal';
COMMENT ON COLUMN hr_certificate_settings.version IS 'pd:none — optimistic version';
COMMENT ON COLUMN hr_certificate_settings.updated_by IS 'pd:personal — settings actor';
COMMENT ON COLUMN hr_certificate_settings.seal_png IS 'pd:personal — optional issuer seal PNG; no remote URL';
COMMENT ON COLUMN hr_certificate_settings.issuer_name IS 'pd:none — configured legal employer, matched against the subject before issuance';

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Widen the deployed passkey-kind check while retaining every existing kind.
-- contract-of: 20261026004009323
-- Request storage is additive; no retention deletion until the owner supplies a rule.
SET LOCAL lock_timeout = '2s';
CREATE TABLE privacy_rights_requests (
    org_id UUID NOT NULL REFERENCES organizations(id),
    id UUID NOT NULL,
    subject_user_id UUID NOT NULL,
    subject_employee_id UUID,
    body JSONB NOT NULL CHECK (jsonb_typeof(body)='object'),
    PRIMARY KEY (org_id,id),
    FOREIGN KEY (org_id,subject_user_id) REFERENCES users(org_id,id)
);
CREATE INDEX privacy_rights_requests_subject ON privacy_rights_requests(org_id,subject_user_id,id DESC);
ALTER TABLE privacy_rights_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_rights_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON privacy_rights_requests
    USING (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid)
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
GRANT SELECT, INSERT ON privacy_rights_requests TO console_rt;
ALTER TABLE auth_webauthn_ceremony_bindings DROP CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check;
ALTER TABLE auth_webauthn_ceremony_bindings ADD CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check CHECK (action_kind IN ('APPROVAL_DECISION','POLL_VOTE','EXIT_CONFIRM','EXIT_RESCIND','ELEVATED_GRANT','PERIOD_UNLOCK','IDENTITY_MERGE','EXCEPTION_DECIDE','SETTINGS_CHANGE','CREDENTIAL_RESET','TENANT_OFFBOARD','OPERATOR_RECOVERY','SUPPORT_SESSION','PII_REVEAL','PII_RECORD','PRIVACY_REQUEST')) NOT VALID;
ALTER TABLE auth_webauthn_ceremony_bindings VALIDATE CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check;
COMMENT ON COLUMN privacy_rights_requests.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN privacy_rights_requests.id IS 'pd:none — receipt identifier';
COMMENT ON COLUMN privacy_rights_requests.subject_user_id IS 'pd:personal — requesting account';
COMMENT ON COLUMN privacy_rights_requests.subject_employee_id IS 'pd:personal — linked data subject';
COMMENT ON COLUMN privacy_rights_requests.body IS 'pd:personal — subject supplied detail, verified identity, and rights receipt';

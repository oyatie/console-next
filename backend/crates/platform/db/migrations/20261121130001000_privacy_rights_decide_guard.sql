-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce forward-only state transitions on privacy_rights_requests and widen passkey step-up bindings for PRIVACY_REQUEST_DECIDE.
-- contract-of: 20261108000000000
SET LOCAL lock_timeout = '2s';

CREATE TRIGGER trg_privacy_rights_requests_guard
    BEFORE UPDATE ON privacy_rights_requests
    FOR EACH ROW EXECUTE FUNCTION privacy_rights_requests_guard();

ALTER TABLE auth_webauthn_ceremony_bindings DROP CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check;
ALTER TABLE auth_webauthn_ceremony_bindings ADD CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check CHECK (action_kind IN ('APPROVAL_DECISION','POLL_VOTE','EXIT_CONFIRM','EXIT_RESCIND','ELEVATED_GRANT','PERIOD_UNLOCK','IDENTITY_MERGE','EXCEPTION_DECIDE','SETTINGS_CHANGE','CREDENTIAL_RESET','TENANT_OFFBOARD','OPERATOR_RECOVERY','SUPPORT_SESSION','PII_REVEAL','PII_RECORD','PRIVACY_REQUEST','PRIVACY_REQUEST_DECIDE')) NOT VALID;
ALTER TABLE auth_webauthn_ceremony_bindings VALIDATE CONSTRAINT auth_webauthn_ceremony_bindings_action_kind_check;

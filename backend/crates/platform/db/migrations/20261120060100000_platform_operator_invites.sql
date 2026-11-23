-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Add platform_operator_invites table for second-operator enrolment provenance.
SET LOCAL lock_timeout = '2s';
-- console-gate: audited-table platform_operator_invites
CREATE TABLE platform_operator_invites (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL,
    credential_id UUID NOT NULL REFERENCES auth_bootstrap_credentials(id) ON DELETE RESTRICT,
    invited_by UUID NOT NULL,
    invite_assertion_id UUID NOT NULL UNIQUE,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    revoked_by UUID,
    revoked_at TIMESTAMPTZ,
    revoke_assertion_id UUID UNIQUE,
    revoke_reason TEXT CHECK (revoke_reason IS NULL OR char_length(btrim(revoke_reason)) BETWEEN 1 AND 500),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (invited_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (revoked_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (invite_assertion_id, org_id) REFERENCES step_up_assertions(ceremony_id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (revoke_assertion_id, org_id) REFERENCES step_up_assertions(ceremony_id, org_id) ON DELETE RESTRICT,
    CHECK (org_id = '00000000-0000-0000-0000-00000000face'::uuid),
    CHECK (expires_at > issued_at),
    CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE INDEX platform_operator_invites_cred_idx
    ON platform_operator_invites (credential_id);
CREATE INDEX platform_operator_invites_user_idx
    ON platform_operator_invites (org_id, user_id, issued_at DESC);
ALTER TABLE platform_operator_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operator_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON platform_operator_invites
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON platform_operator_invites FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON platform_operator_invites TO console_rt;
GRANT UPDATE (redeemed_at, accepted_at, revoked_by, revoked_at, revoke_assertion_id, revoke_reason)
    ON platform_operator_invites TO console_rt;
COMMENT ON TABLE platform_operator_invites IS 'Provenance and lifecycle of platform-tier second-operator enrolment invitations';
COMMENT ON COLUMN platform_operator_invites.id IS 'pd:none — platform operator invite record id';
COMMENT ON COLUMN platform_operator_invites.org_id IS 'pd:none — platform sentinel org scope';
COMMENT ON COLUMN platform_operator_invites.user_id IS 'pd:personal — invited platform operator user id';
COMMENT ON COLUMN platform_operator_invites.credential_id IS 'pd:none — linked bootstrap credential id';
COMMENT ON COLUMN platform_operator_invites.invited_by IS 'pd:personal — inviting platform operator user id';
COMMENT ON COLUMN platform_operator_invites.invite_assertion_id IS 'pd:none — bound passkey step-up assertion authorizing the invite';
COMMENT ON COLUMN platform_operator_invites.issued_at IS 'pd:none — server timestamp when the invite was issued';
COMMENT ON COLUMN platform_operator_invites.expires_at IS 'pd:none — invite expiration timestamp';
COMMENT ON COLUMN platform_operator_invites.redeemed_at IS 'pd:none — timestamp when the invite token was first redeemed';
COMMENT ON COLUMN platform_operator_invites.accepted_at IS 'pd:none — timestamp when passkey registration completed enrolment';
COMMENT ON COLUMN platform_operator_invites.revoked_by IS 'pd:personal — platform operator who revoked or superseded the invite';
COMMENT ON COLUMN platform_operator_invites.revoked_at IS 'pd:none — timestamp when the invite was revoked or superseded';
COMMENT ON COLUMN platform_operator_invites.revoke_assertion_id IS 'pd:none — bound passkey step-up assertion authorizing revocation or reissue';
COMMENT ON COLUMN platform_operator_invites.revoke_reason IS 'pd:none — operational reason code or note for invite revocation';

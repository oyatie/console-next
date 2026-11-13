-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Retain independent decisions without mutating self-attestations.
SET LOCAL lock_timeout = '2s';
-- console-gate: audited-table account_link_self_reviews
CREATE TABLE account_link_self_reviews (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    attestation_id UUID NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('CONFIRM','REVOKE')),
    reviewer_id UUID NOT NULL,
    reviewed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id,attestation_id,decision),
    FOREIGN KEY (attestation_id,org_id) REFERENCES account_link_self_attestations(id,org_id) ON DELETE RESTRICT,
    FOREIGN KEY (reviewer_id,org_id) REFERENCES users(id,org_id) ON DELETE RESTRICT
);
ALTER TABLE account_link_self_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_link_self_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON account_link_self_reviews
    USING (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid)
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
REVOKE ALL ON account_link_self_reviews FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON account_link_self_reviews TO console_rt;
COMMENT ON COLUMN account_link_self_reviews.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN account_link_self_reviews.attestation_id IS 'pd:none — immutable self-attestation receipt';
COMMENT ON COLUMN account_link_self_reviews.decision IS 'pd:none — independent confirmation or revocation';
COMMENT ON COLUMN account_link_self_reviews.reviewer_id IS 'pd:personal — independently verified reviewer';
COMMENT ON COLUMN account_link_self_reviews.reviewed_at IS 'pd:none — server decision time';

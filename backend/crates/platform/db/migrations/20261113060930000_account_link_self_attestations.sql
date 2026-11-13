-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand — Add immutable self-attestation receipts without changing existing binding writers.
-- Expand only: preserve each self-attestation independently of later review decisions.
SET LOCAL lock_timeout = '2s';
-- console-gate: audited-table account_link_self_attestations
CREATE TABLE account_link_self_attestations (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL,
    employee_id UUID NOT NULL,
    attested_at TIMESTAMPTZ NOT NULL,
    eligibility JSONB NOT NULL CHECK (jsonb_typeof(eligibility)='object'),
    review_days INT NOT NULL CHECK (review_days > 0),
    review_due_at TIMESTAMPTZ NOT NULL,
    UNIQUE (id,org_id),
    FOREIGN KEY (id,org_id) REFERENCES step_up_assertions(ceremony_id,org_id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id,org_id) REFERENCES users(id,org_id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id,org_id) REFERENCES employees(id,org_id) ON DELETE RESTRICT
);
CREATE INDEX account_link_self_attestations_account ON account_link_self_attestations(org_id,account_id);
ALTER TABLE account_link_self_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_link_self_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON account_link_self_attestations
    USING (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid)
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org',true),'')::uuid);
REVOKE ALL ON account_link_self_attestations FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON account_link_self_attestations TO console_rt;
COMMENT ON COLUMN account_link_self_attestations.id IS 'pd:none — one-use verified command assertion';
COMMENT ON COLUMN account_link_self_attestations.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN account_link_self_attestations.account_id IS 'pd:personal — self-attesting account';
COMMENT ON COLUMN account_link_self_attestations.employee_id IS 'pd:personal — existing employee record';
COMMENT ON COLUMN account_link_self_attestations.attested_at IS 'pd:none — server attestation time';
COMMENT ON COLUMN account_link_self_attestations.eligibility IS 'pd:none — Cedar eligibility facts at the time of binding';
COMMENT ON COLUMN account_link_self_attestations.review_days IS 'pd:none — resolved review.sole_holder_exception.due setting';
COMMENT ON COLUMN account_link_self_attestations.review_due_at IS 'pd:none — review deadline from the resolved setting';

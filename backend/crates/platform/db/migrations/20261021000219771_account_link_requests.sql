-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; released migrations are immutable.
SET LOCAL lock_timeout = '2s';
-- console-gate: audited-table account_link_requests
CREATE TABLE account_link_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL,
    previous_employee_id UUID,
    employee_id UUID,
    requested_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'SUPERSEDED')),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    UNIQUE (id, org_id),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (requested_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (approved_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    CHECK (requested_by <> user_id),
    CHECK (approved_by IS NULL OR (approved_by <> requested_by AND approved_by <> user_id)),
    CHECK ((status = 'APPROVED') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX account_link_one_pending ON account_link_requests(org_id, user_id) WHERE status = 'PENDING';
ALTER TABLE account_link_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_link_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON account_link_requests
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON account_link_requests FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE ON account_link_requests TO console_rt;
COMMENT ON TABLE account_link_requests IS 'Audited identity-binding proposals; only an independent eligible second person can apply one';
COMMENT ON COLUMN account_link_requests.id IS 'pd:none — proposal reference';
COMMENT ON COLUMN account_link_requests.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN account_link_requests.user_id IS 'pd:personal — affected account';
COMMENT ON COLUMN account_link_requests.previous_employee_id IS 'pd:personal — frozen previous binding';
COMMENT ON COLUMN account_link_requests.employee_id IS 'pd:personal — proposed binding, NULL for unlink';
COMMENT ON COLUMN account_link_requests.requested_by IS 'pd:personal — requester';
COMMENT ON COLUMN account_link_requests.created_at IS 'pd:none — eligibility freeze';
COMMENT ON COLUMN account_link_requests.status IS 'pd:none — proposal state';
COMMENT ON COLUMN account_link_requests.approved_by IS 'pd:personal — independent approver';
COMMENT ON COLUMN account_link_requests.approved_at IS 'pd:none — approval instant';

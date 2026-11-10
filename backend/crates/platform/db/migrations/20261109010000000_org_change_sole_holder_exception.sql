-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Add a tenant-scoped receipt constraint; ordinary approvals retain NULL receipts.
-- contract-of: 0198
-- The governed exception replaces the second-person receipt only for case B.
ALTER TABLE org_change_approval_steps ADD COLUMN sole_holder_exception_id uuid;
ALTER TABLE org_change_approval_steps ADD CONSTRAINT org_change_step_exception_tenant
    FOREIGN KEY (sole_holder_exception_id, org_id) REFERENCES governed_exceptions(id, org_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX org_change_step_exception_once ON org_change_approval_steps(sole_holder_exception_id)
    WHERE sole_holder_exception_id IS NOT NULL;
COMMENT ON COLUMN org_change_approval_steps.sole_holder_exception_id IS 'pd:none — governed exception receipt for this approval step';

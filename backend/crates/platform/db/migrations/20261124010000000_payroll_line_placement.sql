-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- Copied from foreign-keyed rows when a line is written, so no foreign key: one
-- would pull the columns into the erasure order. Per-run scans already use
-- (org_id, run_id, …), so no index either.
ALTER TABLE payroll_draft_lines ADD COLUMN legal_entity_id UUID NULL;
ALTER TABLE payroll_draft_lines ADD COLUMN workplace_id UUID NULL;
ALTER TABLE payroll_draft_lines ADD COLUMN org_unit_id UUID NULL;

COMMENT ON COLUMN payroll_draft_lines.legal_entity_id IS 'pd:personal — the employee''s 법인 at the run period end';
COMMENT ON COLUMN payroll_draft_lines.workplace_id IS 'pd:personal — the employee''s 사업장 at the run period end';
COMMENT ON COLUMN payroll_draft_lines.org_unit_id IS 'pd:personal — the employee''s department at the run period end';

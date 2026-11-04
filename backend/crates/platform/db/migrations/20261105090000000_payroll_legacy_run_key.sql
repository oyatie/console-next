-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — preserve staging uniqueness without constraining pay-group runs
-- contract-of: 0074
SET LOCAL lock_timeout = '2s';
CREATE UNIQUE INDEX payroll_legacy_run_label_key
    ON payroll_draft_runs(org_id,period_start,period_end,source_label)
    WHERE pay_group_id IS NULL;
ALTER TABLE payroll_draft_runs
    DROP CONSTRAINT payroll_draft_runs_org_id_period_start_period_end_source_la_key;

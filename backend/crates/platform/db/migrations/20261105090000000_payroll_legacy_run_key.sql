-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — add the legacy staging key before retiring its full constraint
SET LOCAL lock_timeout = '2s';
CREATE UNIQUE INDEX payroll_legacy_run_label_key
    ON payroll_draft_runs(org_id,period_start,period_end,source_label)
    WHERE pay_group_id IS NULL;

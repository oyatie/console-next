-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — constrain new group identities while preserving legacy NULL facts
-- contract-of: 0074
SET LOCAL lock_timeout = '2s';
ALTER TABLE payroll_draft_runs
    ADD COLUMN pay_group_id UUID,
    ADD COLUMN kind TEXT CHECK (kind IN ('REGULAR','OFF_CYCLE','CORRECTION','EXIT_SETTLEMENT')),
    ADD COLUMN attribution_month DATE CHECK (extract(day FROM attribution_month)=1),
    ADD CONSTRAINT payroll_draft_runs_pay_group_fk
        FOREIGN KEY (org_id,pay_group_id) REFERENCES pay_groups(org_id,id) ON DELETE RESTRICT,
    ADD CONSTRAINT payroll_run_identity_complete CHECK (
        (pay_group_id IS NULL AND kind IS NULL AND attribution_month IS NULL)
        OR (pay_group_id IS NOT NULL AND kind IS NOT NULL AND attribution_month IS NOT NULL));
CREATE UNIQUE INDEX payroll_regular_run_month_key
    ON payroll_draft_runs(org_id,pay_group_id,attribution_month) WHERE kind='REGULAR' AND status<>'VOID';
COMMENT ON COLUMN payroll_draft_runs.pay_group_id IS 'pd:none — explicit pay group; NULL for legacy staging';
COMMENT ON COLUMN payroll_draft_runs.kind IS 'pd:none — run kind; NULL for legacy staging';
COMMENT ON COLUMN payroll_draft_runs.attribution_month IS 'pd:none — derived attribution month';

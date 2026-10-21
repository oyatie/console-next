-- contract-of: 0356
-- Pending, step 1 of 2: not in migrations/, so it does not ship with 0356.
-- Move it into migrations/ under the next version only in a release whose
-- previous release already writes the 연차/근속 pair (the one that shipped
-- 0356), so no serving writer omits the columns; step 2 goes in under the
-- version after it. That release also drops the NULL fallback in
-- hr/adapter-postgres/src/lifecycle/rows.rs (group_transfer_view).
--
-- Steps are separate migrations (separate transactions) so the ACCESS
-- EXCLUSIVE lock of ADD CONSTRAINT is released before step 2's VALIDATE scans
-- under SHARE UPDATE EXCLUSIVE.
SET LOCAL lock_timeout = '2s';

-- Rows the release before 0356 wrote during its rollout overlap (or after a
-- rollback): the one-choice contract, derived as the 0356 backfill and
-- Continuity::parse do. A half-written pair is not derived: step 2's VALIDATE
-- then refuses the migration loudly.
UPDATE employee_group_transfers
SET annual_leave_continuity = continuity,
    seniority_continuity = CASE continuity WHEN 'CARRIED' THEN 'CARRIED' ELSE 'RESTART' END
WHERE annual_leave_continuity IS NULL AND seniority_continuity IS NULL;

-- Enforced for new writes at once; existing rows are proven in step 2.
ALTER TABLE employee_group_transfers
    ADD CONSTRAINT employee_group_transfers_annual_leave_present CHECK (annual_leave_continuity IS NOT NULL) NOT VALID,
    ADD CONSTRAINT employee_group_transfers_seniority_present CHECK (seniority_continuity IS NOT NULL) NOT VALID;

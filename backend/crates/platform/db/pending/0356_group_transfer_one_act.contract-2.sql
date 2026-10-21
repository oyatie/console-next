-- contract-of: 0356
-- Pending, step 2 of 2: ships in the migration right after step 1
-- (0356_group_transfer_one_act.contract-1.sql), never in the same one.
SET LOCAL lock_timeout = '2s';

-- VALIDATE scans under SHARE UPDATE EXCLUSIVE (writes keep flowing); the
-- validated checks then let SET NOT NULL skip its own scan, so its ACCESS
-- EXCLUSIVE lock is brief.
ALTER TABLE employee_group_transfers VALIDATE CONSTRAINT employee_group_transfers_annual_leave_present;
ALTER TABLE employee_group_transfers VALIDATE CONSTRAINT employee_group_transfers_seniority_present;
ALTER TABLE employee_group_transfers
    ALTER COLUMN annual_leave_continuity SET NOT NULL,
    ALTER COLUMN seniority_continuity SET NOT NULL;
ALTER TABLE employee_group_transfers
    DROP CONSTRAINT employee_group_transfers_annual_leave_present,
    DROP CONSTRAINT employee_group_transfers_seniority_present;

COMMENT ON COLUMN employee_group_transfers.annual_leave_continuity IS 'pd:personal — 연차: SETTLED (남은 연차 수당 paid by the sending 법인) or CARRIED (balance and 연차 year carried); chosen, never defaulted';
COMMENT ON COLUMN employee_group_transfers.seniority_continuity IS 'pd:personal — 근속: RESTART (counted from the start date) or CARRIED (counted from the 그룹 입사일); chosen, never defaulted';

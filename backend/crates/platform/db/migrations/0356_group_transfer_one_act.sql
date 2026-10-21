-- 전적 as one act (decisions #30; design/inter-entity-transfer.md T2, §3.3;
-- lifecycle-events-work-items LC-B7, LC-F4). Lane number (head+1 of dev);
-- INTEG renumbers.
--
-- 1. Continuity per dimension (T2): 퇴직금 (the existing `continuity`
--    column), 연차 and 근속 are each chosen, none defaulted. Existing rows
--    recorded one choice for all three, so each new dimension takes it
--    (SETTLED -> SETTLED / RESTART, CARRIED -> CARRIED / CARRIED). Any
--    CARRIED dimension needs the succession agreement's evidence.
-- 2. A 사업장 close plan may move a person to another 법인 (전적): its line
--    names the receiving unit and 사업장 and the GROUP_TRANSFER event the
--    plan recorded with the person's consent.
SET LOCAL lock_timeout = '2s';

-- Expand only: the previous release keeps inserting rows without the two new
-- columns while blue and green share this schema (and after a rollback). They
-- stay NULL-able here; a NULL pair is the one-choice contract of a writer
-- before T2, derived on read by Continuity::parse (console_hr_domain): the one
-- choice names all three, as the backfill below records it. The NOT NULL is
-- the contract,
-- backend/crates/platform/db/pending/0356_group_transfer_one_act.contract-{1,2}.sql.
ALTER TABLE employee_group_transfers
    ADD COLUMN annual_leave_continuity TEXT NULL
        CONSTRAINT employee_group_transfers_annual_leave CHECK (annual_leave_continuity IN ('SETTLED', 'CARRIED')),
    ADD COLUMN seniority_continuity TEXT NULL
        CONSTRAINT employee_group_transfers_seniority CHECK (seniority_continuity IN ('RESTART', 'CARRIED'));
UPDATE employee_group_transfers
SET annual_leave_continuity = continuity,
    seniority_continuity = CASE continuity WHEN 'CARRIED' THEN 'CARRIED' ELSE 'RESTART' END;
-- Any CARRIED dimension needs the succession agreement's evidence. A pre-T2
-- row (NULL pair) passes only where the old check passes it: CARRIED without
-- evidence is still refused by its continuity term.
ALTER TABLE employee_group_transfers
    DROP CONSTRAINT employee_group_transfers_carried_evidence,
    ADD CONSTRAINT employee_group_transfers_carried_evidence CHECK (
        succession_evidence_ref IS NOT NULL
        OR (continuity <> 'CARRIED' AND annual_leave_continuity <> 'CARRIED' AND seniority_continuity <> 'CARRIED'));

-- employee_group_transfers.continuity (now the 퇴직금 dimension) keeps its 0278 classification (one marker per column).
COMMENT ON COLUMN employee_group_transfers.annual_leave_continuity IS 'pd:personal — 연차: SETTLED (남은 연차 수당 paid by the sending 법인) or CARRIED (balance and 연차 year carried); chosen, never defaulted; NULL only from a pre-T2 writer (read as continuity)';
COMMENT ON COLUMN employee_group_transfers.seniority_continuity IS 'pd:personal — 근속: RESTART (counted from the start date) or CARRIED (counted from the 그룹 입사일); chosen, never defaulted; NULL only from a pre-T2 writer (read as RESTART for SETTLED, CARRIED for CARRIED)';

ALTER TABLE workplace_close_lines
    DROP CONSTRAINT workplace_close_lines_action_check,
    DROP CONSTRAINT workplace_close_lines_subject,
    DROP CONSTRAINT workplace_close_lines_target,
    ADD CONSTRAINT workplace_close_lines_action_check
        CHECK (action IN ('TRANSFER', 'EXIT', 'GROUP_TRANSFER', 'MOVE', 'DISSOLVE')),
    ADD CONSTRAINT workplace_close_lines_subject CHECK (
        (action IN ('TRANSFER', 'EXIT', 'GROUP_TRANSFER') AND employee_id IS NOT NULL AND org_unit_id IS NULL)
        OR (action IN ('MOVE', 'DISSOLVE') AND org_unit_id IS NOT NULL AND employee_id IS NULL)),
    ADD CONSTRAINT workplace_close_lines_target CHECK (
        (action IN ('TRANSFER', 'GROUP_TRANSFER', 'MOVE')) = (target_unit_id IS NOT NULL)
        AND (action IN ('TRANSFER', 'GROUP_TRANSFER')) = (target_workplace_id IS NOT NULL)
        AND (action = 'EXIT') = (exit_reason_code IS NOT NULL)),
    ADD CONSTRAINT workplace_close_lines_group_transfer_recorded
        CHECK (action <> 'GROUP_TRANSFER' OR lifecycle_event_id IS NOT NULL);

-- workplace_close_lines.action, target_workplace_id, exit_case_id and lifecycle_event_id now also
-- carry a 전적 (GROUP_TRANSFER); they keep their 0310 classification (one marker per column).

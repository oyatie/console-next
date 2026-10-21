-- E-S3b: 전적, the move of an employee to another 법인 of the tenant
-- (design/legal-entities-and-workplaces §6, ED §3.9, prototype-parity F2).
-- Lane number (head+1 of hard/life/e-s3b); INTEG renumbers at merge.
--
-- One lifecycle event, GROUP_TRANSFER, dated the first day at the receiving
-- 법인 (the last day at the sending 법인 is the day before). It ends the
-- employee's assignment at the sending 법인 and opens one at the receiving
-- 법인 (cause GROUP_TRANSFER) on the same employees row and 사번 (decisions #6:
-- 사번 is tenant-wide); the event id is the assignment's group_transfer_id.
--
-- employee_group_transfers holds the facts the act needs, recorded with it:
--   * the employee's consent (민법 §657①: 사용자는 근로자의 동의 없이 그
--     권리를 제삼자에게 양도하지 못한다) as an attested offline fact with its
--     evidence (decisions #3: never a bare tick);
--   * service continuity, a choice with no default: SETTLED (퇴직금 and 연차
--     settled at the sending 법인) or CARRIED (포괄 승계, which needs the
--     agreement's evidence). Whether 계속근로 legally carries over is listed
--     for the 노무사; the choice is recorded, never inferred;
--   * the 그룹 입사일 carried in either case.
-- Insert-only for console_rt (no UPDATE or DELETE grant).
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_lifecycle_events
    DROP CONSTRAINT IF EXISTS employee_lifecycle_events_event_type_check;
ALTER TABLE employee_lifecycle_events ADD CONSTRAINT employee_lifecycle_events_event_type_check
    CHECK (event_type IN (
        'ONBOARD', 'OFFBOARD', 'TERMINATE', 'TRANSFER',
        'PROMOTE', 'LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'CONTRACT_RENEWAL',
        'EXIT_REVERSAL', 'REHIRE', 'RESCIND', 'GROUP_TRANSFER'
    ));

CREATE TABLE employee_group_transfers (
    org_id                   UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    lifecycle_event_id       UUID        NOT NULL REFERENCES employee_lifecycle_events (id) ON DELETE RESTRICT,
    employee_id              UUID        NOT NULL,
    from_legal_entity_id     UUID        NOT NULL,
    to_legal_entity_id       UUID        NOT NULL,
    to_workplace_id          UUID        NOT NULL,
    start_date               DATE        NOT NULL,
    continuity               TEXT        NOT NULL
        CONSTRAINT employee_group_transfers_continuity CHECK (continuity IN ('SETTLED', 'CARRIED')),
    group_service_start_date DATE        NOT NULL,
    consent_date             DATE        NOT NULL,
    consent_evidence_ref     TEXT        NOT NULL
        CONSTRAINT employee_group_transfers_consent_ref CHECK (char_length(btrim(consent_evidence_ref)) BETWEEN 1 AND 500),
    succession_evidence_ref  TEXT        NULL
        CONSTRAINT employee_group_transfers_succession_ref CHECK (succession_evidence_ref IS NULL OR char_length(btrim(succession_evidence_ref)) BETWEEN 1 AND 500),
    created_by               UUID        NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, lifecycle_event_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, from_legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, to_legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, to_workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employee_group_transfers_other_entity CHECK (from_legal_entity_id <> to_legal_entity_id),
    CONSTRAINT employee_group_transfers_carried_evidence CHECK (continuity <> 'CARRIED' OR succession_evidence_ref IS NOT NULL),
    CONSTRAINT employee_group_transfers_consent_first CHECK (consent_date <= start_date),
    CONSTRAINT employee_group_transfers_service_start CHECK (group_service_start_date <= start_date)
);
CREATE INDEX employee_group_transfers_employee_idx ON employee_group_transfers (org_id, employee_id);

ALTER TABLE employee_group_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_group_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_group_transfers
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT ON employee_group_transfers TO console_rt;

COMMENT ON TABLE employee_group_transfers IS 'E-S3b 전적: the consent, continuity and 그룹 입사일 recorded with a GROUP_TRANSFER lifecycle event; insert-only';
COMMENT ON COLUMN employee_group_transfers.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN employee_group_transfers.lifecycle_event_id IS 'pd:none — the GROUP_TRANSFER event; also the assignments'' group_transfer_id';
COMMENT ON COLUMN employee_group_transfers.employee_id IS 'pd:personal — the employee who moves';
COMMENT ON COLUMN employee_group_transfers.from_legal_entity_id IS 'pd:personal — sending 법인 (the employer before); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_group_transfers.to_legal_entity_id IS 'pd:personal — receiving 법인 (the employer after); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_group_transfers.to_workplace_id IS 'pd:personal — receiving 사업장; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employee_group_transfers.start_date IS 'pd:personal — first day at the receiving 법인 (the last at the sending 법인 is the day before)';
COMMENT ON COLUMN employee_group_transfers.continuity IS 'pd:personal — SETTLED (settled at the sending 법인) or CARRIED (포괄 승계); chosen, never defaulted';
COMMENT ON COLUMN employee_group_transfers.group_service_start_date IS 'pd:personal — 그룹 입사일 carried over';
COMMENT ON COLUMN employee_group_transfers.consent_date IS 'pd:personal — date the employee consented (민법 §657①)';
COMMENT ON COLUMN employee_group_transfers.consent_evidence_ref IS 'pd:personal — attachment or document reference for the consent';
COMMENT ON COLUMN employee_group_transfers.succession_evidence_ref IS 'pd:personal — attachment or document reference for the 포괄 승계 agreement (CARRIED)';
COMMENT ON COLUMN employee_group_transfers.created_by IS 'pd:personal — user who recorded the 전적';
COMMENT ON COLUMN employee_group_transfers.created_at IS 'pd:none — when it was recorded';

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- LC-B4/B5/B6: expand the dossier without changing N-1 writers.
SET LOCAL lock_timeout = '2s';

ALTER TABLE legal_entities ADD COLUMN time_zone TEXT;
ALTER TABLE workplaces ADD COLUMN time_zone TEXT;
COMMENT ON COLUMN legal_entities.time_zone IS 'pd:none — owning legal entity IANA time zone';
COMMENT ON COLUMN workplaces.time_zone IS 'pd:none — workplace IANA time zone, inherited from legal entity when absent';
CREATE TABLE lifecycle_country_packs (
    country_code TEXT PRIMARY KEY,
    time_zone TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX lifecycle_country_pack_default ON lifecycle_country_packs (is_default) WHERE is_default;
INSERT INTO lifecycle_country_packs VALUES ('KR', 'Asia/Seoul',true);
REVOKE ALL ON lifecycle_country_packs FROM PUBLIC, console_rt;
GRANT SELECT ON lifecycle_country_packs TO console_rt;
COMMENT ON COLUMN lifecycle_country_packs.country_code IS 'pd:none — jurisdiction pack key';
COMMENT ON COLUMN lifecycle_country_packs.time_zone IS 'pd:none — jurisdiction default IANA time zone';
COMMENT ON COLUMN lifecycle_country_packs.is_default IS 'pd:none — fallback pack for unplaced records';
CREATE FUNCTION lifecycle_time_zone(p_org UUID,p_employee UUID,p_on DATE,p_workplace UUID DEFAULT NULL)
RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT COALESCE(w.time_zone,e.time_zone,p.time_zone)
 FROM lifecycle_country_packs p
 LEFT JOIN LATERAL (SELECT a.workplace_id,a.legal_entity_id FROM employment_assignments a
   WHERE a.org_id=p_org AND a.employee_id=p_employee AND a.superseded_at IS NULL AND a.valid_from<=p_on
   ORDER BY a.valid_from DESC LIMIT 1) a ON true
 LEFT JOIN workplaces w ON w.org_id=p_org AND w.id=COALESCE(p_workplace,a.workplace_id)
 LEFT JOIN legal_entities e ON e.org_id=p_org AND e.id=COALESCE(w.legal_entity_id,a.legal_entity_id)
 WHERE p.is_default
$$;
REVOKE ALL ON FUNCTION lifecycle_time_zone(UUID,UUID,DATE,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_time_zone(UUID,UUID,DATE,UUID) TO console_rt;

ALTER TABLE case_template_items ADD COLUMN opens_on DATE;
ALTER TABLE case_template_items ADD COLUMN opens_rule_ref TEXT;
ALTER TABLE case_template_items ADD COLUMN label_key TEXT;
ALTER TABLE case_template_items ADD COLUMN completion_rule_ref TEXT;
ALTER TABLE case_template_items ADD COLUMN waiver_rule_ref TEXT;
ALTER TABLE lifecycle_case_items ADD COLUMN completion_reason TEXT;
COMMENT ON COLUMN case_template_items.completion_rule_ref IS 'pd:none — governed attestation rule';
COMMENT ON COLUMN case_template_items.waiver_rule_ref IS 'pd:none — governed waiver rule';
COMMENT ON COLUMN lifecycle_case_items.completion_reason IS 'pd:none — retained waiver reason';
ALTER TABLE lifecycle_case_items ADD COLUMN opens_on DATE;
ALTER TABLE lifecycle_case_items ADD COLUMN opens_rule_ref TEXT;
ALTER TABLE lifecycle_cases ADD COLUMN cancellation_reason TEXT;
ALTER TABLE lifecycle_cases ADD COLUMN org_unit_id UUID;
COMMENT ON COLUMN lifecycle_cases.org_unit_id IS 'pd:personal — event department snapshot for HR trail authorization';
COMMENT ON COLUMN case_template_items.opens_on IS 'pd:none — optional fixed opening date';
COMMENT ON COLUMN case_template_items.opens_rule_ref IS 'pd:none — statutory opening rule reference';
COMMENT ON COLUMN case_template_items.label_key IS 'pd:none — catalog key for the item label';
COMMENT ON COLUMN lifecycle_case_items.opens_on IS 'pd:none — earliest legal day, in the owning workplace zone';
COMMENT ON COLUMN lifecycle_case_items.opens_rule_ref IS 'pd:none — statutory opening rule reference';
COMMENT ON COLUMN lifecycle_cases.cancellation_reason IS 'pd:none — retained event withdrawal or void reason';
CREATE UNIQUE INDEX lifecycle_cases_event_once ON lifecycle_cases (org_id, trigger_id, kind)
    WHERE trigger_kind = 'LIFECYCLE_EVENT';

-- Triggers and insurers belong to the effective-dated register, including legacy slices.
ALTER TABLE statutory_rules ADD COLUMN trigger_event_kinds TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE statutory_rules ADD COLUMN case_opens_offset_days INT;
COMMENT ON COLUMN statutory_rules.case_opens_offset_days IS 'pd:none — existing case window opening offset from its template anchor';
UPDATE statutory_rules SET case_opens_offset_days=1
WHERE code IN ('FINAL_PAY_DUE_DAYS','SEVERANCE_PAY_DUE_DAYS');
COMMENT ON COLUMN statutory_rules.trigger_event_kinds IS 'pd:none — lifecycle event kinds opening the register filing';
UPDATE statutory_rules SET trigger_event_kinds =
    CASE filing_rule->>'filing_kind'
      WHEN 'ACQUIRE' THEN ARRAY['ONBOARD','REHIRE','GROUP_TRANSFER']
      WHEN 'AGE60' THEN ARRAY['ONBOARD','REHIRE','GROUP_TRANSFER']
      WHEN 'LOSE' THEN ARRAY['TERMINATE','OFFBOARD','GROUP_TRANSFER']
      WHEN 'LEAVE' THEN ARRAY['LEAVE_OF_ABSENCE']
      WHEN 'RESUME' THEN ARRAY['RETURN_FROM_LEAVE']
      WHEN 'CHANGE' THEN ARRAY['APPOINT','TRANSFER']
      ELSE '{}'::text[] END
WHERE filing_rule IS NOT NULL;

CREATE TABLE lifecycle_case_triggers (
    event_type TEXT PRIMARY KEY,
    template_key TEXT NOT NULL,
    case_kind TEXT NOT NULL
);
INSERT INTO lifecycle_case_triggers VALUES
 ('ONBOARD','HIRE','HIRE'), ('REHIRE','HIRE','HIRE'),
 ('APPOINT','APPOINT','APPOINT'), ('TRANSFER','APPOINT','APPOINT'),
 ('LEAVE_OF_ABSENCE','LEAVE_START','LEAVE_START'),
 ('RETURN_FROM_LEAVE','LEAVE_RETURN','LEAVE_RETURN'),
 ('CONTRACT_RENEWAL','CONTRACT','CONTRACT'),
 ('TERMINATE','EXIT','EXIT'), ('OFFBOARD','EXIT','EXIT'),
 ('GROUP_TRANSFER','GROUP_TRANSFER_HIRE','HIRE');
REVOKE ALL ON lifecycle_case_triggers FROM PUBLIC, console_rt;
GRANT SELECT ON lifecycle_case_triggers TO console_rt;
COMMENT ON COLUMN lifecycle_case_triggers.event_type IS 'pd:none — lifecycle ledger event vocabulary';
COMMENT ON COLUMN lifecycle_case_triggers.template_key IS 'pd:none — opening template';
COMMENT ON COLUMN lifecycle_case_triggers.case_kind IS 'pd:none — case kind';

CREATE TABLE filing_obligations (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL,
    filing_kind TEXT NOT NULL,
    insurer TEXT NOT NULL,
    PRIMARY KEY (org_id,id),
    UNIQUE (org_id,event_id,filing_kind,insurer)
);
ALTER TABLE filing_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE filing_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON filing_obligations
 USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
 WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON filing_obligations FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON filing_obligations TO console_rt;
COMMENT ON COLUMN filing_obligations.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN filing_obligations.id IS 'pd:none — shared filing identity';
COMMENT ON COLUMN filing_obligations.event_id IS 'pd:none — event or statutory request source';
COMMENT ON COLUMN filing_obligations.filing_kind IS 'pd:none — register filing kind';
COMMENT ON COLUMN filing_obligations.insurer IS 'pd:none — register insurer';

INSERT INTO case_templates (template_key,version,kind,effective_from,change_note)
SELECT k,1,kind,DATE '1900-01-01','LC-B5: structural checklist; legal review required'
FROM (VALUES ('HIRE','HIRE'),('APPOINT','APPOINT'),('LEAVE_START','LEAVE_START'),
 ('LEAVE_RETURN','LEAVE_RETURN'),('CONTRACT','CONTRACT'),('GROUP_TRANSFER_HIRE','HIRE')) v(k,kind);

-- Operational records have no statutory deadline until the register supplies one.
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,
 owner_line,due_rule_kind,blocks_close,legal,basis_tag)
SELECT template_key,1,'R1',1,'사건 기록','lifecycle.trail.record','REC','IN_CONSOLE','OBSERVED',
 'hr_basic.edit','UNKNOWN',true,false,'U' FROM case_templates WHERE template_key <> 'EXIT';
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,
 owner_line,due_rule_kind,blocks_close,legal,basis_tag)
SELECT template_key,1,'D1',2,'서류 확인','lifecycle.trail.documents','DOC','OUTSIDE','ATTESTED',
 'hr_basic.edit','UNKNOWN',true,false,'U' FROM case_templates WHERE template_key <> 'EXIT';

-- Copy the register citation; do not make a new legal reading here.
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,
 owner_line,due_anchor,due_rule_kind,due_register_code,opens_rule_ref,blocks_close,legal,
 instrument_ko,article_ko,basis_tag)
SELECT t.template_key,1,'F'||row_number() OVER (PARTITION BY t.template_key ORDER BY r.code),
 10+row_number() OVER (PARTITION BY t.template_key ORDER BY r.code),
 r.filing_rule->>'insurer','lifecycle.trail.filing','FIL','OUTSIDE','ATTESTED','hr_basic.edit',
 'EFFECTIVE_DATE','DAYS_AFTER',r.code,r.code,true,true,r.instrument_ko,r.article_ko,'U'
FROM case_templates t
JOIN (SELECT DISTINCT ON (code) * FROM statutory_rules WHERE filing_rule IS NOT NULL
 ORDER BY code,effective_from DESC) r ON
 (t.template_key IN ('HIRE','GROUP_TRANSFER_HIRE') AND r.filing_rule->>'filing_kind' = 'ACQUIRE') OR
 (t.template_key = 'LEAVE_START' AND r.filing_rule->>'filing_kind' = 'LEAVE') OR
 (t.template_key = 'LEAVE_RETURN' AND r.filing_rule->>'filing_kind' = 'RESUME') OR
 (t.template_key = 'APPOINT' AND r.filing_rule->>'filing_kind' = 'CHANGE');

UPDATE case_template_items SET completion_rule_ref='LIFECYCLE_ITEM_ATTESTED',waiver_rule_ref='LIFECYCLE_ITEM_WAIVED'
WHERE mode IN ('ATTESTED','REQUESTED');
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,kind,venue,mode,owner_line,applicability,
 due_anchor,due_rule_kind,due_register_code,opens_rule_ref,blocks_close,legal,instrument_ko,article_ko,basis_tag,
 completion_rule_ref,waiver_rule_ref)
SELECT 'EXIT',1,'X20',100,'산재보험 상실신고','FIL','OUTSIDE','ATTESTED','hr_basic.edit','{INSURER_APPLIES_IACI}',
 'EXIT_DATE','DAY_OF_NEXT_MONTH',r.code,r.code,true,true,r.instrument_ko,r.article_ko,'U',
 'LIFECYCLE_ITEM_ATTESTED','LIFECYCLE_ITEM_WAIVED'
FROM statutory_rules r WHERE r.code='ins.deadline.lose.iaci' ORDER BY r.effective_from DESC LIMIT 1;

UPDATE case_template_items SET opens_rule_ref = due_register_code WHERE due_register_code IS NOT NULL;

-- Existing audit outbox remains the sole event producer.
INSERT INTO realtime_topic_map (target_type,action,resource_type,carries_id)
SELECT target,action,resource,false FROM (VALUES
 ('employee','employee.lifecycle.record'),('employee','employee.lifecycle.schedule'),
 ('employee','employee.lifecycle.cancel'),('employee','employee.lifecycle.rescind'),
 ('employee','employee.lifecycle.apply'),('employee','employee.lifecycle.correct'),
 ('employee','employee.create'),('employee','employee.rehire'),
 ('employee_exit_case','employee.exit.report'),('employee_exit_case','employee.exit.confirm'),('employee_exit_case','employee.exit.cancel'),('employee_exit_case','employee.exit.reject'),('insurance_filing','insurance_filing.recorded'),
 ('lifecycle_case','lifecycle_case.updated'),('lifecycle_case','lifecycle_case.clock_tick')) v(target,action)
CROSS JOIN (VALUES ('lifecycle_case'),('lifecycle_case_item')) r(resource)
ON CONFLICT DO NOTHING;

-- A waived remainder still needs a governed waiver on each blocking item.
CREATE OR REPLACE FUNCTION lifecycle_cases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state = 'CLOSED' AND EXISTS (
        SELECT 1 FROM lifecycle_case_items i WHERE i.org_id=NEW.org_id AND i.case_id=NEW.id
        AND i.blocks_close AND i.status IN ('PENDING_TRIGGER','OPEN','BLOCKED')) THEN
        RAISE EXCEPTION 'case_has_open_items: case % has an open blocking item',NEW.id USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.state='CANCELLED' AND NEW.state<>'CANCELLED' THEN
        RAISE EXCEPTION 'lifecycle case % was cancelled and cannot reopen',OLD.id USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END $$;

UPDATE realtime_topic_map SET carries_id=false WHERE resource_type IN ('lifecycle_case','lifecycle_case_item');

UPDATE case_template_items SET applicability=array_append(applicability,'!CONTINUITY_CARRIED')
WHERE template_key='EXIT' AND item_key IN ('X4','X5','X7','X15');
UPDATE case_template_items SET label_key='lifecycle.trail.documents.'||lower(template_key)
WHERE item_key='D1' AND template_key<>'EXIT';
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,owner_line,
 due_rule_kind,blocks_close,legal,basis_tag,completion_rule_ref,waiver_rule_ref)
SELECT template_key,1,'A1',3,'권한 변경 확인','lifecycle.trail.accessReview','ACC','IN_CONSOLE','ATTESTED','access.edit',
 'UNKNOWN',false,false,'U','LIFECYCLE_ITEM_ATTESTED','LIFECYCLE_ITEM_WAIVED'
FROM case_templates WHERE template_key IN ('HIRE','GROUP_TRANSFER_HIRE','APPOINT','LEAVE_START','LEAVE_RETURN');

-- Retention needs its own reviewed evidence; an exit event is no storage receipt.
UPDATE case_template_items SET owner_line='hr_basic.edit',completion_rule_ref='LIFECYCLE_ITEM_ATTESTED',waiver_rule_ref='LIFECYCLE_ITEM_WAIVED'
WHERE template_key='EXIT' AND item_key='X17';

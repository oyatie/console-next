-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Restore hire facts inside the one case; register-owned workplace-change placeholders remain unverified.
SET LOCAL lock_timeout = '2s';
ALTER TABLE case_template_items ADD COLUMN checklist_item TEXT;
ALTER TABLE case_template_items ADD COLUMN record_target TEXT CHECK (record_target IN ('facts','contract'));
COMMENT ON COLUMN case_template_items.checklist_item IS 'pd:none — existing onboarding checklist fact key';
COMMENT ON COLUMN case_template_items.record_target IS 'pd:none — existing product form for the fact';
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,
 owner_line,due_rule_kind,blocks_close,legal,basis_tag,checklist_item,record_target)
SELECT t.template_key,t.version,'H'||row_number() OVER (PARTITION BY t.template_key,t.version ORDER BY f.key),
 30+row_number() OVER (PARTITION BY t.template_key,t.version ORDER BY f.key),f.label,'enum.checklistItem.'||f.key,
 'DOC','IN_CONSOLE','OBSERVED','hr_basic.edit','UNKNOWN',false,false,'U',f.key,f.target
FROM case_templates t CROSS JOIN (VALUES
 ('BIRTH_DATE_RECORDED','생년월일 등록','facts'),('ID_REGISTERED','신분증 종류 등록','facts'),
 ('PAY_RECORDED','기본급 등록','facts'),('CONTRACT_RECORDED','입사일부터의 근로계약 기록','contract')) f(key,label,target)
WHERE t.kind='HIRE';
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,
 owner_line,due_rule_kind,blocks_close,legal,basis_tag,completion_rule_ref,waiver_rule_ref)
SELECT template_key,version,'HD1',40,'근로계약서 교부','enum.checklistItem.CONTRACT_DELIVERED','DOC','OUTSIDE','ATTESTED',
 'hr_basic.edit','UNKNOWN',false,false,'U','LIFECYCLE_ITEM_ATTESTED','LIFECYCLE_ITEM_WAIVED'
FROM case_templates WHERE kind='HIRE';

-- Older binaries validate the core register vocabulary. Draft rules live beside it until those readers retire.
ALTER TABLE statutory_rules ADD COLUMN requires_workplace_change BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN statutory_rules.requires_workplace_change IS 'pd:none — register trigger requires a change of workplace';
CREATE TABLE statutory_filing_drafts (
    code TEXT NOT NULL CHECK (code IN ('ins.deadline.change.nps','ins.deadline.change.nhis','ins.deadline.change.ei','ins.deadline.change.iaci')),
    effective_from DATE NOT NULL,
    effective_to_exclusive DATE CHECK (effective_to_exclusive IS NULL OR effective_to_exclusive>effective_from),
    unit TEXT NOT NULL CHECK (unit IN ('DAYS','MONTHS','YEARS','DAY_OF_NEXT_MONTH','HOURS_PER_WEEK','ANNUAL_RATE')),
    value_num BIGINT NOT NULL CHECK (value_num>=0),
    value_den BIGINT NOT NULL DEFAULT 1 CHECK (value_den>0),
    instrument_ko TEXT NOT NULL CHECK (btrim(instrument_ko)<>''),
    article_ko TEXT NOT NULL CHECK (btrim(article_ko)<>''),
    promulgation_ko TEXT NOT NULL CHECK (btrim(promulgation_ko)<>''),
    enforced_on DATE NOT NULL,
    source_url TEXT NOT NULL CHECK (source_url LIKE 'https://www.law.go.kr/_%'),
    retrieved_on DATE NOT NULL,
    provenance_ko TEXT NOT NULL CHECK (btrim(provenance_ko)<>''),
    release_disposition TEXT NOT NULL DEFAULT 'HOLD' CHECK (release_disposition IN ('HOLD','RELEASED')),
    review_receipt_ref TEXT CHECK (review_receipt_ref IS NULL OR btrim(review_receipt_ref)<>''),
    filing_rule JSONB NOT NULL CHECK (jsonb_typeof(filing_rule)='object' AND filing_rule->>'filing_kind'='CHANGE'),
    trigger_event_kinds TEXT[] NOT NULL DEFAULT '{}',
    case_opens_offset_days INT,
    requires_workplace_change BOOLEAN NOT NULL DEFAULT true,
    CHECK ((release_disposition='RELEASED')=(review_receipt_ref IS NOT NULL)),
    CHECK (effective_from>=enforced_on),
    PRIMARY KEY (code,effective_from)
);
COMMENT ON COLUMN statutory_filing_drafts.code IS 'pd:none — statutory draft register code';
COMMENT ON COLUMN statutory_filing_drafts.effective_from IS 'pd:none — statutory draft register effective_from';
COMMENT ON COLUMN statutory_filing_drafts.effective_to_exclusive IS 'pd:none — statutory draft register effective_to_exclusive';
COMMENT ON COLUMN statutory_filing_drafts.unit IS 'pd:none — statutory draft register unit';
COMMENT ON COLUMN statutory_filing_drafts.value_num IS 'pd:none — statutory draft register value_num';
COMMENT ON COLUMN statutory_filing_drafts.value_den IS 'pd:none — statutory draft register value_den';
COMMENT ON COLUMN statutory_filing_drafts.instrument_ko IS 'pd:none — statutory draft register instrument_ko';
COMMENT ON COLUMN statutory_filing_drafts.article_ko IS 'pd:none — statutory draft register article_ko';
COMMENT ON COLUMN statutory_filing_drafts.promulgation_ko IS 'pd:none — statutory draft register promulgation_ko';
COMMENT ON COLUMN statutory_filing_drafts.enforced_on IS 'pd:none — statutory draft register enforced_on';
COMMENT ON COLUMN statutory_filing_drafts.source_url IS 'pd:none — statutory draft register source_url';
COMMENT ON COLUMN statutory_filing_drafts.retrieved_on IS 'pd:none — statutory draft register retrieved_on';
COMMENT ON COLUMN statutory_filing_drafts.provenance_ko IS 'pd:none — statutory draft register provenance_ko';
COMMENT ON COLUMN statutory_filing_drafts.release_disposition IS 'pd:none — statutory draft register release_disposition';
COMMENT ON COLUMN statutory_filing_drafts.review_receipt_ref IS 'pd:none — statutory draft register review_receipt_ref';
COMMENT ON COLUMN statutory_filing_drafts.filing_rule IS 'pd:none — statutory draft register filing_rule';
COMMENT ON COLUMN statutory_filing_drafts.trigger_event_kinds IS 'pd:none — statutory draft register trigger_event_kinds';
COMMENT ON COLUMN statutory_filing_drafts.case_opens_offset_days IS 'pd:none — statutory draft register case_opens_offset_days';
COMMENT ON COLUMN statutory_filing_drafts.requires_workplace_change IS 'pd:none — statutory draft register requires_workplace_change';
REVOKE ALL ON statutory_filing_drafts FROM PUBLIC, console_rt;
GRANT SELECT ON statutory_filing_drafts TO console_rt;
CREATE VIEW lifecycle_statutory_rules AS SELECT * FROM statutory_rules UNION ALL SELECT * FROM statutory_filing_drafts;
REVOKE ALL ON lifecycle_statutory_rules FROM PUBLIC, console_rt;
GRANT SELECT ON lifecycle_statutory_rules TO console_rt;
-- Copy each pack's insurer and provenance, never infer a change deadline or legal applicability.
INSERT INTO statutory_filing_drafts (code,effective_from,effective_to_exclusive,unit,value_num,value_den,
 instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,provenance_ko,filing_rule,trigger_event_kinds,requires_workplace_change)
SELECT 'ins.deadline.change.'||lower(filing_rule->>'insurer'),effective_from,effective_to_exclusive,'DAYS',0,1,
 instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,
 '법무 검토 전: 사업장 변경 시 신고 적용 및 기한 미확인. 인용은 보험 제도 출처이며 전근 신고 의무의 확인이 아님.',
 filing_rule || jsonb_build_object('code','ins.deadline.change.'||lower(filing_rule->>'insurer'),
 'filing_kind','CHANGE','deadline',jsonb_build_object('anchor','EFFECTIVE_DATE','kind','UNKNOWN','value',NULL,'first_day','EXCLUDED'),
 'candidate',NULL,'opens_anchor','EFFECTIVE_DATE','opens_offset',0,'loss_offset_days',0,
 'penalty',NULL,'covered_by',NULL,'age_trigger_years',NULL,'exclusions','[]'::jsonb,
 'applicability_unverified',true,'applicability_anchor','EFFECTIVE_DATE'),ARRAY['APPOINT','TRANSFER'],true
FROM statutory_rules WHERE filing_rule->>'filing_kind'='ACQUIRE';
INSERT INTO case_template_items (template_key,version,item_key,ord,label_ko,label_key,kind,venue,mode,owner_line,
 variants,due_anchor,due_rule_kind,due_register_code,opens_rule_ref,blocks_close,legal,instrument_ko,article_ko,basis_tag)
SELECT 'APPOINT',1,'W'||row_number() OVER (ORDER BY r.code),50+row_number() OVER (ORDER BY r.code),
 r.filing_rule->>'insurer','lifecycle.trail.filing','FIL','OUTSIDE','ATTESTED','hr_basic.edit',
 ARRAY['WORKPLACE_CHANGE'],'EFFECTIVE_DATE','DAYS_AFTER',r.code,r.code,true,true,r.instrument_ko,r.article_ko,'U'
FROM (SELECT DISTINCT ON (code) * FROM lifecycle_statutory_rules WHERE filing_rule->>'filing_kind'='CHANGE'
 ORDER BY code,effective_from DESC) r;
-- Existing cases receive the restored facts too, without replacing any recorded result.
INSERT INTO lifecycle_case_items (org_id,case_id,item_key,source,template_item_version,kind,venue,mode,owner_line,
 due_disposition,status,blocks_close,legal)
SELECT c.org_id,c.id,t.item_key,'TEMPLATE',t.version,t.kind,t.venue,t.mode,t.owner_line,'UNKNOWN',
 CASE WHEN l.state='SCHEDULED' THEN 'PENDING_TRIGGER' ELSE 'OPEN' END,t.blocks_close,t.legal
FROM lifecycle_cases c JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version
LEFT JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=c.trigger_id
WHERE c.kind='HIRE' AND c.state='OPEN' AND (t.checklist_item IS NOT NULL OR t.item_key='HD1') ON CONFLICT DO NOTHING;

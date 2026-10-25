-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Draft obligations cannot demand an unrecordable receipt. Release remains owned by the register.
SET LOCAL lock_timeout = '2s';
ALTER TABLE insurance_filing_records DROP CONSTRAINT insurance_filing_records_filing_kind_check;
ALTER TABLE insurance_filing_records ADD CONSTRAINT insurance_filing_records_filing_kind_check
 CHECK (filing_kind IN ('ACQUIRE','LOSE','LEAVE','RESUME','AGE60','WORK_CONFIRMATION','SEPARATION_CERTIFICATE','ACQUIRE_REQUESTED','MONTHLY_REMUNERATION','CHANGE'));

CREATE VIEW lifecycle_filing_rules AS
 SELECT code,effective_from,effective_to_exclusive,unit,value_num,value_den,
 instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,provenance_ko,
 release_disposition,review_receipt_ref,filing_rule,trigger_event_kinds,case_opens_offset_days,requires_workplace_change,
 NULL::boolean AS recording_held FROM statutory_rules
 UNION ALL
 SELECT code,effective_from,effective_to_exclusive,unit,value_num,value_den,
 instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,provenance_ko,
 release_disposition,review_receipt_ref,filing_rule,trigger_event_kinds,case_opens_offset_days,requires_workplace_change,
 release_disposition<>'RELEASED' OR COALESCE((filing_rule->>'applicability_unverified')::boolean,true) AS recording_held
 FROM statutory_filing_drafts;

REVOKE ALL ON lifecycle_filing_rules FROM PUBLIC, console_rt;
GRANT SELECT ON lifecycle_filing_rules TO console_rt;

UPDATE lifecycle_case_items i SET blocks_close=false,status='BLOCKED',status_code='LEGAL_REVIEW',version=i.version+1
 FROM lifecycle_cases c,lifecycle_filing_rules r
 WHERE c.org_id=i.org_id AND c.id=i.case_id AND c.state='OPEN' AND i.kind='FIL'
 AND r.code=i.due_rule_ref AND r.effective_from<=c.effective_date
 AND (r.effective_to_exclusive IS NULL OR c.effective_date<r.effective_to_exclusive)
 AND r.recording_held AND i.status IN ('OPEN','PENDING_TRIGGER','BLOCKED');

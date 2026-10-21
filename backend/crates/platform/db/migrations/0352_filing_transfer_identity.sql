-- A 전적 is both 상실 and 취득 (#30). The receipt identity includes the filing kind.
SET LOCAL lock_timeout = '2s';
ALTER TABLE insurance_filing_records
    ADD COLUMN filing_kind TEXT NOT NULL DEFAULT 'ACQUIRE'
    CHECK (filing_kind IN ('ACQUIRE', 'LOSE', 'LEAVE', 'RESUME'));
ALTER TABLE insurance_filing_records DROP CONSTRAINT insurance_filing_records_org_id_event_id_insurer_version_key;
ALTER TABLE insurance_filing_records ADD UNIQUE (org_id, event_id, filing_kind, insurer, version);
COMMENT ON COLUMN insurance_filing_records.filing_kind IS 'pd:personal — reporting obligation kind for the lifecycle event';

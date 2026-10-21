-- CX-statutory: append-only manual filing receipts and verified deadline references.
-- Expand only. Previous releases can ignore this table. Reference rows remain HOLD.
SET LOCAL lock_timeout = '2s';
ALTER TABLE statutory_rules DROP CONSTRAINT statutory_rules_code_check;
ALTER TABLE statutory_rules ADD CONSTRAINT statutory_rules_code_check CHECK (code IN (

    'FINAL_PAY_DUE_DAYS', 'LATE_WAGE_INTEREST_ANNUAL_RATE', 'DISMISSAL_NOTICE_DAYS',
    'AVERAGE_WAGE_WINDOW_MONTHS', 'EMPLOYMENT_RECORD_RETENTION_YEARS',
    'EMPLOYMENT_CERTIFICATE_REQUEST_YEARS', 'EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS',
    'SEVERANCE_PAY_DUE_DAYS', 'SEVERANCE_MIN_SERVICE_YEARS', 'SEVERANCE_MIN_WEEKLY_HOURS',
    'EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH', 'NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH',
    'NHIS_LOSS_REPORT_DUE_DAYS', 'SEPARATION_CERTIFICATE_DUE_DAYS', 'FIXED_TERM_MAX_YEARS',
    'MANAGERIAL_DISMISSAL_CONSULT_DAYS', 'UNFAIR_DISMISSAL_CLAIM_MONTHS',
    'ins.deadline.acquire.nps', 'ins.deadline.acquire.nhis', 'ins.deadline.acquire.ei', 'ins.deadline.acquire.iaci', 'ins.deadline.lose.iaci', 'ins.deadline.leave.ei', 'ins.deadline.leave.iaci'));

INSERT INTO statutory_rules (code, effective_from, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko)
SELECT v.code, s.effective_from, s.unit, s.value_num, s.value_den,
    s.instrument_ko, v.article, s.promulgation_ko, s.enforced_on, s.source_url,
    DATE '2026-10-07', 'lifecycle-events.md §3.1/§5.3: 같은 조문의 취득 신고 기한. 휴일 이월과 기산은 노무사 검토 전 HOLD.'
FROM (VALUES
    ('ins.deadline.acquire.nps', 'NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH', '제6조제1항 사업장가입자 자격취득 신고: 사유가 발생한 달의 다음 달 15일까지'),
    ('ins.deadline.acquire.nhis', 'NHIS_LOSS_REPORT_DUE_DAYS', '제9조제1항제1호·제2호 및 제2항제1호: 자격이 변동된 날부터 14일 이내'),
    ('ins.deadline.acquire.ei', 'EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH', '제7조제1항 피보험자격 취득 신고: 사유가 발생한 달의 다음 달 15일까지')
) v(code, source, article) JOIN statutory_rules s ON s.code = v.source;

INSERT INTO statutory_rules (code, effective_from, unit, value_num, value_den,
    instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko)
SELECT code, DATE '2026-09-18', unit, n, 1,
    '고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률', article,
    '법률 제21472호', DATE '2026-09-18',
    'https://www.law.go.kr/법령/고용보험및산업재해보상보험의보험료징수등에관한법률',
    DATE '2026-10-07', 'lifecycle-events.md G14, §3.1 H8, §5.3; DRF MST 285369/284441. 노무사 검토 전 HOLD. 복직 및 연금·건강 휴직 기한은 미확인으로 숫자를 넣지 않음.'
FROM (VALUES
    ('ins.deadline.acquire.iaci', 'DAY_OF_NEXT_MONTH', 15, '제16조의10제3항 근로자 고용 신고: 다음 달 15일까지'),
    ('ins.deadline.lose.iaci', 'DAY_OF_NEXT_MONTH', 15, '제16조의10제3항 고용관계 종료 신고: 다음 달 15일까지'),
    ('ins.deadline.leave.ei', 'DAYS', 14, '제16조의10제5항 휴직 신고: 사유가 발생한 날부터 14일 이내'),
    ('ins.deadline.leave.iaci', 'DAYS', 14, '제16조의10제5항 휴직 신고: 사유가 발생한 날부터 14일 이내')
) v(code, unit, n, article);

CREATE TABLE insurance_filing_records (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id UUID NOT NULL DEFAULT uuidv7(),
    event_id UUID NOT NULL REFERENCES employee_lifecycle_events(id) ON DELETE RESTRICT,
    insurer TEXT NOT NULL CHECK (insurer IN ('NPS', 'NHIS', 'EI', 'IACI')),
    version BIGINT NOT NULL CHECK (version > 0),
    action TEXT NOT NULL CHECK (action IN ('COMPLETE', 'UNDO')),
    completed_on DATE NULL,
    receipt_number TEXT NULL CHECK (char_length(btrim(receipt_number)) BETWEEN 1 AND 100),
    loss_code TEXT NULL CHECK (char_length(btrim(loss_code)) BETWEEN 1 AND 100),
    detail TEXT NULL CHECK (char_length(btrim(detail)) BETWEEN 1 AND 1000),
    actor UUID NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, event_id, insurer, version),
    UNIQUE (org_id, actor, idempotency_key),
    FOREIGN KEY (actor, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK ((action = 'COMPLETE') = (completed_on IS NOT NULL)),
    CHECK (action = 'COMPLETE' OR (receipt_number IS NULL AND loss_code IS NULL AND detail IS NULL))
);
CREATE UNIQUE INDEX insurance_filing_receipt_unique ON insurance_filing_records(org_id, insurer, receipt_number)
    WHERE receipt_number IS NOT NULL;
CREATE FUNCTION insurance_filing_records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'insurance filing records are append-only' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM employee_lifecycle_events e WHERE e.id = NEW.event_id AND e.org_id = NEW.org_id) THEN
        RAISE EXCEPTION 'insurance filing event must belong to the same organization' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_insurance_filing_records_guard BEFORE INSERT OR UPDATE OR DELETE ON insurance_filing_records
    FOR EACH ROW EXECUTE FUNCTION insurance_filing_records_guard();
ALTER TABLE insurance_filing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_filing_records FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON insurance_filing_records
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON insurance_filing_records FROM PUBLIC;
GRANT SELECT, INSERT ON insurance_filing_records TO console_rt;
COMMENT ON COLUMN insurance_filing_records.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN insurance_filing_records.id IS 'pd:personal — receipt record identifier';
COMMENT ON COLUMN insurance_filing_records.event_id IS 'pd:personal — employee lifecycle event identifier';
COMMENT ON COLUMN insurance_filing_records.insurer IS 'pd:personal — insurer of the employee filing';
COMMENT ON COLUMN insurance_filing_records.version IS 'pd:none — optimistic concurrency version';
COMMENT ON COLUMN insurance_filing_records.action IS 'pd:personal — filing record action';
COMMENT ON COLUMN insurance_filing_records.completed_on IS 'pd:personal — reported filing date';
COMMENT ON COLUMN insurance_filing_records.receipt_number IS 'pd:personal — agency receipt evidence';
COMMENT ON COLUMN insurance_filing_records.loss_code IS 'pd:personal — recorded statutory loss reason';
COMMENT ON COLUMN insurance_filing_records.detail IS 'pd:personal — loss reason detail';
COMMENT ON COLUMN insurance_filing_records.actor IS 'pd:personal — recording account identifier';
COMMENT ON COLUMN insurance_filing_records.recorded_at IS 'pd:none — recording timestamp';
COMMENT ON COLUMN insurance_filing_records.idempotency_key IS 'pd:none — retry key';
COMMENT ON COLUMN insurance_filing_records.request_hash IS 'pd:none — request fingerprint';

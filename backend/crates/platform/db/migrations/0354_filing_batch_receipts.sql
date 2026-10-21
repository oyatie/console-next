-- Agency batch receipts may evidence several workers; identity is the event/kind/insurer/version.
SET LOCAL lock_timeout = '2s';
DROP INDEX insurance_filing_receipt_unique;
CREATE INDEX insurance_filing_receipt_lookup ON insurance_filing_records(org_id, insurer, receipt_number)
    WHERE receipt_number IS NOT NULL;

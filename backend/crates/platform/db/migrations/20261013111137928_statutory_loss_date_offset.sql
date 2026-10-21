-- The membership-loss date offset is legal reference data, shared by every filing view.
SET LOCAL lock_timeout = '2s';
UPDATE statutory_rules SET filing_rule=filing_rule || jsonb_build_object('loss_offset_days',1)
WHERE filing_rule IS NOT NULL;

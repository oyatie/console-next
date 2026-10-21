-- Complete the filing metadata without changing the frozen expansion migration.
SET LOCAL lock_timeout = '2s';
UPDATE statutory_rules SET filing_rule = filing_rule || jsonb_build_object(
 'remuneration_required', filing_rule->>'filing_kind'='LOSE' AND filing_rule->>'insurer' IN ('EI','IACI'),
 'applicability_anchor', CASE WHEN filing_rule->>'filing_kind' IN ('ACQUIRE','LOSE','AGE60','ACQUIRE_REQUESTED') THEN 'ACQUIRE_DATE' ELSE 'EFFECTIVE_DATE' END)
WHERE filing_rule IS NOT NULL;
UPDATE statutory_rules loss SET filing_rule = loss.filing_rule || jsonb_build_object('exclusions',acquire.filing_rule->'exclusions')
FROM statutory_rules acquire WHERE loss.filing_rule->>'filing_kind' IN ('LOSE','AGE60')
 AND acquire.filing_rule->>'filing_kind'='ACQUIRE' AND acquire.filing_rule->>'insurer'=loss.filing_rule->>'insurer'
 AND loss.effective_from>=acquire.effective_from AND (acquire.effective_to_exclusive IS NULL OR loss.effective_from<acquire.effective_to_exclusive);
UPDATE statutory_rules SET filing_rule=filing_rule || jsonb_build_object('age_limit_anchor','EXIT_DATE','age_limit_offset',-1)
WHERE filing_rule->>'insurer'='NPS' AND filing_rule->>'filing_kind'='LOSE';
UPDATE statutory_rules SET filing_rule=filing_rule || jsonb_build_object('opens_anchor','ACQUIRE_DATE') WHERE filing_rule->>'filing_kind'='ACQUIRE_REQUESTED';
UPDATE statutory_rules SET filing_rule=filing_rule || jsonb_build_object('daily_required',true)
WHERE filing_rule->>'filing_kind'='WORK_CONFIRMATION';
UPDATE statutory_rules SET filing_rule=filing_rule || jsonb_build_object(
 'deadline',jsonb_build_object('anchor','EXIT_DATE','kind','DAY_OF_NEXT_MONTH','value',15,'first_day','EXCLUDED'),
 'candidate',jsonb_build_object('anchor','LOSS_DATE','kind','DAY_OF_NEXT_MONTH','value',15,'first_day','EXCLUDED'))
WHERE filing_rule->>'filing_kind'='AGE60';
-- Penalties are displayed only where their cited version was already in force.
UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{penalty}','null'::jsonb)
WHERE filing_rule->'penalty' IS NOT NULL AND (filing_rule->'penalty'->'citation'->>'enforced_on')::date>effective_from;

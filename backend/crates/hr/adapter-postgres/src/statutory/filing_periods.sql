-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Resolve version boundaries once for ranking, birthday checks and detail hydration.
WITH source_bounds AS (
    SELECT min(first_on) AS first_on, max(last_on) AS last_on
    FROM (
        SELECT effective_date::date - (event_type = 'GROUP_TRANSFER')::int AS first_on,
               effective_date::date AS last_on
        FROM employee_lifecycle_events WHERE org_id = $1
        UNION ALL
        SELECT anchor_on, anchor_on FROM insurance_filing_requests
        WHERE org_id = $1 AND filing_kind <> 'ACQUIRE_REQUESTED'
    ) sources
), versions AS MATERIALIZED (
    SELECT code, effective_from, effective_to_exclusive, filing_rule,
           recording_held, requires_workplace_change, trigger_event_kinds,
           filing_rule->>'filing_kind' AS filing_kind, filing_rule->>'insurer' AS insurer,
           COALESCE((filing_rule->>'loss_offset_days')::int, 0) AS loss_days
    FROM lifecycle_filing_rules WHERE filing_rule IS NOT NULL
), periods AS (
    SELECT r.*, r.effective_from AS event_from, r.effective_to_exclusive AS event_until
    FROM versions r WHERE filing_kind <> 'LOSE'
    UNION ALL
    -- The loss offset is selected at exit. The duty can be a later version
    -- when the offset crosses a cutover.
    SELECT r.*, greatest(base.effective_from, r.effective_from - base.loss_days),
           least(base.effective_to_exclusive, r.effective_to_exclusive - base.loss_days)
    FROM versions r JOIN versions base USING (filing_kind, insurer)
    WHERE r.filing_kind = 'LOSE' AND daterange(base.effective_from, base.effective_to_exclusive)
        && daterange(r.effective_from - base.loss_days, r.effective_to_exclusive - base.loss_days)
)
SELECT jsonb_agg(jsonb_build_object(
           'event_from', event_from, 'event_until', event_until, 'filing_kind', filing_kind,
           'insurer', insurer, 'is_age', filing_rule->>'age_trigger_years' IS NOT NULL,
           'recording_held', recording_held, 'requires_workplace_change', requires_workplace_change,
           'trigger_event_kinds', trigger_event_kinds
       )) AS periods, filing_rule, min(event_from) AS first_possible_on
FROM periods CROSS JOIN source_bounds
WHERE filing_rule->>'age_trigger_years' IS NOT NULL
   OR (event_from <= last_on AND (event_until IS NULL OR first_on < event_until))
GROUP BY code, effective_from, filing_rule

-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- migration-backfill: Record the legal entity, workplace and department of existing payroll lines at their run period end; N-1 readers ignore the columns.
SET LOCAL lock_timeout = '2s';

-- The same placement the roster writer records, without the company name:
-- closed runs keep the name they showed.
-- shortcut: one-off; a backdated correction recorded before this runs is taken
-- as true for closed runs.
-- shortcut: lines a previous binary writes between this migration and the
-- rollout stay unplaced when that binary closes their run, or re-stages a run
-- already closed, in those minutes; add a re-run of this backfill if it shows.
UPDATE payroll_draft_lines
   SET legal_entity_id = p.legal_entity_id, workplace_id = p.workplace_id,
       org_unit_id = p.org_unit_id
  FROM (
    SELECT dl.id, a.legal_entity_id, a.workplace_id,
           COALESCE(mv.from_org_unit_id, e.org_unit_id) AS org_unit_id
    FROM payroll_draft_lines dl
    JOIN payroll_draft_runs r ON r.org_id = dl.org_id AND r.id = dl.run_id
    LEFT JOIN pay_groups g ON g.org_id = r.org_id AND g.id = r.pay_group_id
    JOIN employees e ON e.org_id = dl.org_id AND e.id = dl.employee_id
    LEFT JOIN LATERAL (
        -- An import run's line shows the person was paid in the period, so when
        -- every assignment starts later (a start date filled in from when the
        -- record was created) the earliest is the best placement known.
        SELECT x.legal_entity_id, x.workplace_id FROM employment_assignments x
        WHERE x.org_id = e.org_id AND x.employee_id = e.id AND x.superseded_at IS NULL
          AND (g.legal_entity_id IS NULL
               OR x.legal_entity_id = g.legal_entity_id AND x.valid_from <= r.period_end)
        ORDER BY x.valid_from <= r.period_end DESC,
                 CASE WHEN x.valid_from <= r.period_end THEN x.valid_from END DESC,
                 x.valid_from, x.created_at DESC
        LIMIT 1
    ) a ON TRUE
    LEFT JOIN LATERAL (
        SELECT h.from_org_unit_id FROM employee_lifecycle_events h
        WHERE h.org_id = e.org_id AND h.employee_id = e.id
          AND h.state = 'APPLIED' AND h.event_type <> 'RESCIND'
          AND h.to_org_unit_id IS NOT NULL AND h.to_org_unit_id IS DISTINCT FROM h.from_org_unit_id
          AND entity_try_iso_date(h.effective_date) > r.period_end
          AND NOT EXISTS (
              SELECT 1 FROM employee_lifecycle_events v
              WHERE v.org_id = h.org_id AND v.voids_event_id = h.id AND v.state = 'APPLIED'
          )
        ORDER BY entity_try_iso_date(h.effective_date), h.created_at, h.id LIMIT 1
    ) mv ON TRUE
  ) p
 WHERE payroll_draft_lines.id = p.id
   AND (payroll_draft_lines.legal_entity_id, payroll_draft_lines.workplace_id,
        payroll_draft_lines.org_unit_id)
       IS DISTINCT FROM (p.legal_entity_id, p.workplace_id, p.org_unit_id);

// SPDX-License-Identifier: LicenseRef-Proprietary
//! Each line's legal entity, workplace and department as of its run's period end,
//! and the legal entity name the line prints.
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// One UPDATE over a run's lines. The placement is the assignment in force at the
/// period end, or the last one held before it, so a leaver keeps the legal entity
/// and workplace they left from; a pay-group run looks only at its own legal
/// entity. A line never placed keeps the company it was written with; a placed
/// line names its legal entity.
const PLACE_LINES_SQL: &str = r#"
UPDATE payroll_draft_lines l
   SET legal_entity_id = p.legal_entity_id, workplace_id = p.workplace_id,
       org_unit_id = p.org_unit_id, employee_company = p.company, updated_at = now()
  FROM (
    SELECT dl.id, a.legal_entity_id, a.workplace_id,
           COALESCE(mv.from_org_unit_id, e.org_unit_id) AS org_unit_id,
           CASE WHEN a.legal_entity_id IS NOT NULL THEN COALESCE(certificate.name, 'UNKNOWN_COMPANY')
                WHEN dl.legal_entity_id IS NULL THEN dl.employee_company
                ELSE 'UNKNOWN_COMPANY' END AS company
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
        -- The department a later move left is the one held at the period end.
        -- shortcut: events recorded before from_org_unit_id existed, and org-chart
        -- rebinds that write no event, fall back to today's department; upgrade when
        -- department history is queryable.
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
    LEFT JOIN LATERAL (
        -- The legal entity name has one stored source (the entity), shown once a non-voided registration certificate open on the date is confirmed; no imported label is evidence.
        SELECT x.name FROM legal_entity_revisions x
        WHERE x.org_id = e.org_id AND x.legal_entity_id = a.legal_entity_id AND x.effective_from <= r.period_end
          AND EXISTS (
              SELECT 1 FROM business_registrations h
              WHERE h.org_id = e.org_id AND h.legal_entity_id = a.legal_entity_id AND NOT h.needs_confirmation
                AND h.voided_at IS NULL AND (h.closed_on IS NULL OR h.closed_on > r.period_end)
          )
        ORDER BY x.effective_from DESC, x.version DESC LIMIT 1
    ) certificate ON TRUE
    WHERE dl.org_id = $1 AND dl.run_id = $2
  ) p
 WHERE l.id = p.id
   AND (l.legal_entity_id, l.workplace_id, l.org_unit_id, l.employee_company)
       IS DISTINCT FROM (p.legal_entity_id, p.workplace_id, p.org_unit_id, p.company)
"#;

pub(super) async fn place_lines_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(PLACE_LINES_SQL)
        .bind(org_id)
        .bind(run_id)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

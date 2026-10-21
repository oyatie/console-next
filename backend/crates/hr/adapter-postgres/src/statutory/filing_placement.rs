//! Birthday-derived events are scoped at their actual date, using the same Cedar reach as every filing.
use super::FilingTask;
use crate::{
    HrError,
    authz::{Tier, hr_reach_in, push_reach_at_unit},
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_platform_authz::{Feature, Principal};
use sqlx::{Postgres, QueryBuilder, Row, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) async fn place_ages(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    items: &mut Vec<FilingTask>,
) -> Result<(), HrError> {
    let dates = items
        .iter()
        .filter(|t| t.kind == "AGE60")
        .map(|t| {
            Ok((
                t.event_id,
                t.employee_id,
                parse_yyyy_mm_dd(&t.effective_date)?,
            ))
        })
        .collect::<Result<Vec<_>, HrError>>()?;
    if dates.is_empty() {
        return Ok(());
    }
    let reach = hr_reach_in(p, Feature::EmployeeDirectoryManage, Tier::Branch)?;
    let mut q = QueryBuilder::<Postgres>::new("WITH dates(event_id,employee_id,on_date) AS (");
    q.push_values(dates, |mut b, (event, employee, on)| {
        b.push_bind(event).push_bind(employee).push_bind(on);
    });
    q.push(") SELECT d.event_id,ea.legal_entity_id,ea.workplace_id,w.name FROM dates d JOIN employees e ON e.id=d.employee_id \
      JOIN LATERAL (SELECT a.legal_entity_id,a.workplace_id FROM employment_assignments a WHERE a.org_id=e.org_id AND a.employee_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=d.on_date AND (a.valid_to IS NULL OR a.valid_to>d.on_date) ORDER BY a.valid_from DESC LIMIT 1) ea ON TRUE \
      LEFT JOIN LATERAL (SELECT h.to_org_unit_id AS org_unit_id FROM employee_lifecycle_events h WHERE h.org_id=e.org_id AND h.employee_id=e.id AND h.state='APPLIED' AND h.effective_date::date<=d.on_date AND h.to_org_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=h.org_id AND v.voids_event_id=h.id AND v.state='APPLIED') ORDER BY h.effective_date::date DESC,h.created_at DESC LIMIT 1) unit ON TRUE \
      LEFT JOIN LATERAL (SELECT r.name FROM workplace_revisions r WHERE r.org_id=e.org_id AND r.workplace_id=ea.workplace_id AND r.effective_from<=d.on_date ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) w ON TRUE WHERE e.org_id=")
      .push_bind(p.org_id.as_uuid()).push(" AND ");
    push_reach_at_unit(&mut q, &reach, "COALESCE(unit.org_unit_id,e.org_unit_id)");
    let rows = q.build().fetch_all(tx.as_mut()).await?;
    let mut placements = BTreeMap::new();
    for r in rows {
        placements.insert(
            r.try_get::<Uuid, _>("event_id")?,
            (
                r.try_get("legal_entity_id")?,
                r.try_get("workplace_id")?,
                r.try_get("name")?,
            ),
        );
    }
    items.retain_mut(|t| {
        if t.kind != "AGE60" {
            return true;
        }
        if let Some((entity, site, name)) = placements.remove(&t.event_id) {
            t.legal_entity_id = entity;
            t.workplace_id = site;
            t.workplace_name = name;
            true
        } else {
            false
        }
    });
    Ok(())
}

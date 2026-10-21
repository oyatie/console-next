//! The tenant's structure and roster as the schedule resolver needs them:
//! 법인, 사업장 (with their branch for scoping), 부서 heads up to their site,
//! and the people placed on a date. 부서 membership is the current value
//! (`employees.org_unit_id`); assignments to 법인 · 사업장 are dated. Every
//! list built from it follows the chart's order ([`OrgModel::tree_rank`]).
// ponytail: 부서 on a past date is today's 부서 (no dated membership exists on
//! (`employees.org_unit_id`); assignments to 법인 · 사업장 are dated.
// 부서 on a past date is today's 부서 (no dated membership exists on
// trunk); a dated read lands with the org-history reader.

use std::collections::HashMap;

use console_orgchange_domain::{TreeEntry, tree_order};
use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use super::ScheduleStoreError;

#[derive(Debug, Clone)]
pub(crate) struct Workplace {
    pub legal_entity_id: Uuid,
    pub branch_id: Option<Uuid>,
    pub name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Unit {
    pub name: String,
    pub parent: Option<Uuid>,
    pub is_site: bool,
    /// For a site unit, the 사업장 it represents.
    pub workplace: Option<Uuid>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct OrgModel {
    pub entities: HashMap<Uuid, String>,
    pub workplaces: HashMap<Uuid, Workplace>,
    pub units: HashMap<Uuid, Unit>,
    /// 근무조 id -> (사업장, name).
    pub crews: HashMap<Uuid, (Uuid, String)>,
    /// 순서 among its siblings: every 법인 and 사업장 (dense, as the chart
    /// reads them), a 부서 when it has an `org_unit_positions` row.
    pub positions: HashMap<Uuid, i32>,
}

impl OrgModel {
    /// Every 법인, 사업장 and 부서 by its place in the chart's order
    /// (`tree_order`, the rule GET /org-units uses): 법인 › 사업장 › 부서,
    /// siblings in their stored 순서. A 부서 under a site hangs off its 사업장.
    pub fn tree_rank(&self) -> HashMap<Uuid, usize> {
        let entry = |id: &Uuid, parent, name| TreeEntry {
            id: *id,
            parent,
            position: self.positions.get(id).copied(),
            name,
        };
        let mut entries: Vec<TreeEntry<'_>> = Vec::new();
        entries.extend(self.entities.iter().map(|(id, name)| entry(id, None, name)));
        entries.extend(
            self.workplaces
                .iter()
                .map(|(id, w)| entry(id, Some(w.legal_entity_id), &w.name)),
        );
        entries.extend(
            self.units
                .iter()
                .filter(|(_, u)| !u.is_site)
                .map(|(id, u)| {
                    let parent = u.parent.and_then(|p| match self.units.get(&p) {
                        Some(site) if site.is_site => site.workplace,
                        _ => Some(p),
                    });
                    entry(id, parent, &u.name)
                }),
        );
        tree_order(&entries)
            .into_iter()
            .enumerate()
            .map(|(rank, id)| (id, rank))
            .collect()
    }

    /// A 부서 and its 부서 ancestors with their depth, stopping at the site.
    pub fn chain(&self, unit: Uuid) -> Vec<(Uuid, u8)> {
        let mut out = Vec::new();
        let mut at = Some(unit);
        let mut depth = 0u8;
        while let Some(id) = at {
            let Some(u) = self.units.get(&id) else { break };
            if u.is_site || depth > 64 {
                break;
            }
            out.push((id, depth));
            at = u.parent;
            depth += 1;
        }
        out
    }

    /// The 사업장 a 부서 sits under (through its site unit).
    pub fn workplace_of_unit(&self, unit: Uuid) -> Option<Uuid> {
        let mut at = Some(unit);
        for _ in 0..64 {
            let u = self.units.get(&at?)?;
            if u.is_site {
                return u.workplace;
            }
            at = u.parent;
        }
        None
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Person {
    pub id: Uuid,
    pub number: Option<String>,
    pub name: String,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub unit: Option<Uuid>,
    pub crew: Option<Uuid>,
}

const ENTITIES_SQL: &str = "SELECT e.id, \
     (row_number() OVER (ORDER BY e.sort_order NULLS LAST, e.created_at, e.id) - 1)::int AS position, (SELECT COALESCE(x.display_name, x.name) FROM legal_entity_revisions x \
     WHERE x.org_id = e.org_id AND x.legal_entity_id = e.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) AS name \
     FROM legal_entities e WHERE e.voided_at IS NULL";
const WORKPLACES_SQL: &str = "SELECT w.id, w.legal_entity_id, w.default_branch_id, (row_number() OVER \
     (PARTITION BY w.legal_entity_id ORDER BY w.sort_order NULLS LAST, w.created_at, w.id) - 1)::int AS position, (SELECT x.name FROM workplace_revisions x \
     WHERE x.org_id = w.org_id AND x.workplace_id = w.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) AS name \
     FROM workplaces w WHERE w.voided_at IS NULL";
const UNITS_SQL: &str = "SELECT h.org_unit_id, h.attributes->>'name' AS name, h.attributes->>'parent_id' AS parent, \
     h.attributes->>'kind' AS kind, p.workplace_id, o.position FROM (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes \
     FROM org_unit_revisions ORDER BY org_unit_id, version DESC) h \
     LEFT JOIN org_unit_placements p ON p.org_unit_id = h.org_unit_id AND p.represents_workplace AND p.valid_to IS NULL \
     LEFT JOIN org_unit_positions o ON o.org_unit_id = h.org_unit_id \
     WHERE COALESCE(h.attributes->>'status', '') <> 'dissolved' AND h.attributes->>'kind' IN ('site', 'department', 'team')";
const ROSTER_SQL: &str = "SELECT e.id, e.employee_number, e.name, a.legal_entity_id, a.workplace_id, e.org_unit_id, m.crew_id \
     FROM employees e \
     JOIN employment_assignments a ON a.org_id = e.org_id AND a.employee_id = e.id AND a.superseded_at IS NULL \
      AND a.valid_from <= $1 AND (a.valid_to IS NULL OR a.valid_to > $1) \
     LEFT JOIN attendance_crew_members m ON m.org_id = e.org_id AND m.employee_id = e.id \
      AND m.valid_from <= $1 AND (m.valid_to IS NULL OR m.valid_to > $1) \
     WHERE e.merged_into_employee_id IS NULL AND e.employment_status <> 'VOIDED' \
       AND (e.hire_on IS NULL OR e.hire_on <= $1) AND (e.exit_on IS NULL OR e.exit_on >= $1) \
       AND ($2::uuid IS NULL OR e.id = $2) \
     ORDER BY e.employee_number NULLS LAST, e.name, e.id";

pub(crate) async fn load_org(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<OrgModel, ScheduleStoreError> {
    let mut org = OrgModel::default();
    for row in sqlx::query(ENTITIES_SQL).fetch_all(tx.as_mut()).await? {
        let (id, name): (Uuid, Option<String>) = (row.try_get("id")?, row.try_get("name")?);
        org.positions.insert(id, row.try_get("position")?);
        org.entities.insert(id, name.unwrap_or_default());
    }
    for row in sqlx::query(WORKPLACES_SQL).fetch_all(tx.as_mut()).await? {
        let (id, name): (Uuid, Option<String>) = (row.try_get("id")?, row.try_get("name")?);
        org.positions.insert(id, row.try_get("position")?);
        org.workplaces.insert(
            id,
            Workplace {
                legal_entity_id: row.try_get("legal_entity_id")?,
                branch_id: row.try_get("default_branch_id")?,
                name: name.unwrap_or_default(),
            },
        );
    }
    for row in sqlx::query(UNITS_SQL).fetch_all(tx.as_mut()).await? {
        let parent: Option<String> = row.try_get("parent")?;
        let kind: Option<String> = row.try_get("kind")?;
        let name: Option<String> = row.try_get("name")?;
        let id: Uuid = row.try_get("org_unit_id")?;
        if let Some(position) = row.try_get::<Option<i32>, _>("position")? {
            org.positions.insert(id, position);
        }
        org.units.insert(
            id,
            Unit {
                name: name.unwrap_or_default(),
                parent: parent.and_then(|p| Uuid::parse_str(&p).ok()),
                is_site: kind.as_deref() == Some("site"),
                workplace: row.try_get("workplace_id")?,
            },
        );
    }
    for row in
        sqlx::query("SELECT id, workplace_id, name FROM attendance_crews WHERE status = 'ACTIVE'")
            .fetch_all(tx.as_mut())
            .await?
    {
        org.crews.insert(
            row.try_get("id")?,
            (row.try_get("workplace_id")?, row.try_get("name")?),
        );
    }
    Ok(org)
}

/// People placed on `date` (one person when `only` is set).
pub(crate) async fn load_roster(
    tx: &mut Transaction<'_, Postgres>,
    date: Date,
    only: Option<Uuid>,
) -> Result<Vec<Person>, ScheduleStoreError> {
    let rows = sqlx::query(ROSTER_SQL)
        .bind(date)
        .bind(only)
        .fetch_all(tx.as_mut())
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(Person {
                id: row.try_get(0)?,
                number: row.try_get(1)?,
                name: row.try_get(2)?,
                legal_entity_id: row.try_get(3)?,
                workplace_id: row.try_get(4)?,
                unit: row.try_get(5)?,
                crew: row.try_get(6)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(name: &str, parent: Option<Uuid>, site: Option<Uuid>) -> Unit {
        Unit {
            name: name.into(),
            parent,
            is_site: site.is_some(),
            workplace: site,
        }
    }

    #[test]
    fn a_chain_climbs_departments_and_stops_at_the_site() {
        let (wp, site, dept, team) = (
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            Uuid::from_u128(4),
        );
        let mut org = OrgModel::default();
        org.units.insert(site, unit("평택공장", None, Some(wp)));
        org.units.insert(dept, unit("생산부", Some(site), None));
        org.units.insert(team, unit("생산1팀", Some(dept), None));
        assert_eq!(org.chain(team), vec![(team, 0), (dept, 1)]);
        assert_eq!(org.workplace_of_unit(team), Some(wp));
        assert_eq!(org.chain(site), vec![]);
    }
}

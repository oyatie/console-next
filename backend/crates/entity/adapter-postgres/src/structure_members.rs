// SPDX-License-Identifier: LicenseRef-Proprietary
//! Inspector membership uses exactly the chart's authorized temporal resolver.
use console_entity_application::{Actor, OrgStructureNode, ReadOptions, ReadPoint};
use console_entity_domain::Refusal;
use console_orgchange_domain::{OrgUnitMemberView, OrgUnitMembersView};
use console_platform_db::with_org_snapshot;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgEntityError, PgEntityStore};

fn visible(nodes: &[OrgStructureNode], unit: Uuid) -> bool {
    nodes
        .iter()
        .any(|n| n.id == unit || n.org_unit_id == Some(unit) || visible(&n.children, unit))
}

impl PgEntityStore {
    /// # Errors
    /// Not found outside the authorized dated chart; database faults.
    pub async fn structure_members_at(
        &self,
        actor: &Actor,
        unit: Uuid,
        q: ReadOptions,
    ) -> Result<OrgUnitMembersView, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_snapshot(&self.pool, actor.org, |tx| {
            Box::pin(async move {
                let chart = crate::structure::compose(tx, granted.as_deref(), q).await?;
                if !visible(&chart.entities, unit) && !visible(&chart.unplaced, unit) {
                    return Err(Refusal::not_found("org_unit_not_found").into());
                }
                let point = ReadPoint::new(crate::today_kst(tx).await?, q);
                let mut tree = crate::asof::tree::load(tx, point).await?;
                let mut members = crate::asof::membership::load(tx, point).await?;
                crate::asof::projection::apply(tx, point, &mut tree, &mut members).await?;
                let since: std::collections::HashMap<_, _> = members.iter().filter(|m| m.unit == Some(unit))
                    .map(|m| (m.employee, m.unit_since)).collect();
                let ids: Vec<_> = since.keys().copied().collect();
                let headcount = i64::try_from(since.len()).unwrap_or(i64::MAX);
                let rows = sqlx::query(
                    "SELECT e.id, e.name, e.employee_number, e.position, title.label AS title FROM person_employees_current e \
                     LEFT JOIN job_titles title ON title.org_id=e.org_id AND title.id=e.position_kind_id \
                     WHERE e.id = ANY($1) ORDER BY e.name, e.id LIMIT 200",
                ).bind(ids).fetch_all(tx.as_mut()).await?;
                let items = rows.iter().map(|row| Ok(OrgUnitMemberView {
                    employee_id: row.try_get("id")?, name: row.try_get("name")?,
                    employee_number: row.try_get("employee_number")?, position: row.try_get("position")?,
                    title: row.try_get("title")?,
                    since: since.get(&row.try_get::<Uuid, _>("id")?).copied().flatten(),
                })).collect::<Result<_, sqlx::Error>>()?;
                Ok(OrgUnitMembersView { headcount, items })
            })
        }).await
    }
}

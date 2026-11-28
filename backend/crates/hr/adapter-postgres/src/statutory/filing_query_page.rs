// SPDX-License-Identifier: LicenseRef-Proprietary
use super::FilingQuery;
use sqlx::{Postgres, QueryBuilder};

pub(super) fn push_employee_join(q: &mut QueryBuilder<Postgres>, lightweight: bool) {
    q.push(" FROM sources l ").push(if lightweight {
        // The whole-cohort rank can join the canonical roster once.
        "JOIN person_employees_current x ON x.org_id=l.org_id AND x.id=l.employee_id"
    } else {
        // Page hydration must probe only the selected employees, even before ANALYZE.
        "JOIN LATERAL (SELECT * FROM person_employees_current WHERE org_id=l.org_id AND id=l.employee_id OFFSET 0) x ON true"
    });
}

pub(super) fn push_page_order(q: &mut QueryBuilder<Postgres>, query: &FilingQuery) -> &'static str {
    if let Some(limit) = query.inbox_scan_limit {
        if let Some((created_at, id)) = &query.inbox_after {
            q.push(" WHERE (created_at, inbox_id) > (")
                .push_bind(*created_at)
                .push(", ")
                .push_bind(id.clone())
                .push(")");
        }
        let order = " ORDER BY created_at, inbox_id";
        q.push(order)
            .push(" LIMIT ")
            .push_bind(i64::try_from(limit).unwrap_or(i64::MAX));
        order
    } else {
        let order = " ORDER BY effective_date,id,kind,insurer";
        q.push(order);
        order
    }
}

pub(super) fn push_workplace_zones(q: &mut QueryBuilder<Postgres>, lightweight: bool) {
    // A shared zone already determines every candidate's filing date.
    q.push(", page_workplaces AS MATERIALIZED (SELECT DISTINCT workplace_id FROM hydrated \
        WHERE workplace_id IS NOT NULL AND (SELECT shared_time_zone IS NULL FROM boundary)), \
        page_zones AS MATERIALIZED (SELECT w.id,lifecycle_time_zone(w.org_id,NULL,current_date,w.id) AS time_zone \
        FROM page_workplaces p JOIN workplaces w ON w.id=p.workplace_id AND w.org_id=(SELECT org_id FROM boundary) WHERE w.legal_entity_id IS NOT NULL), \
        zoned AS ");
    if !lightweight {
        q.push("MATERIALIZED ");
    }
    q.push("(SELECT paged.*,COALESCE((SELECT shared_time_zone FROM boundary),z.time_zone,lifecycle_time_zone((SELECT org_id FROM boundary),paged.employee_id,paged.placement_on,paged.workplace_id)) AS time_zone \
        FROM hydrated paged LEFT JOIN page_zones z ON z.id=paged.workplace_id) \
      ");
}

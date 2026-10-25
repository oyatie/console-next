//! The oracle: the pre-rewrite five-pass facets and the full-FROM total.

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::directory::read_facets::FacetCount;
use console_hr_adapter_postgres::directory::read_filters::{
    EmployeeListFilters, counted_employees, filtered_employees, push_filtered_from,
};
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Row};
use uuid::Uuid;

/// The pre-rewrite facets: one pass per group over the full FROM.
pub async fn oracle(pool: &PgPool, org: Uuid, filters: EmployeeListFilters) -> Value {
    with_org_conn::<_, _, HrError>(pool, OrgId::from_uuid(org), move |tx| {
        Box::pin(async move {
            let grouped = |column: &'static str, filters: EmployeeListFilters| {
                let mut q = filtered_employees(&format!("SELECT {column} AS value, count(*) AS n"), &filters);
                q.push(format!(" GROUP BY {column} ORDER BY {column} NULLS LAST"));
                q
            };
            let mut by_status = filters.clone();
            by_status.statuses.clear();
            let mut by_entity = filters.clone();
            by_entity.legal_entity_id = None;
            let mut by_workplace = filters.clone();
            by_workplace.workplace_id = None;
            let mut by_review = filters.clone();
            by_review.identity_review_required = None;
            by_review.register_review_required = None;
            by_review.home_branch_review_required = None;
            by_review.lifecycle_apply_failed = None;
            by_review.contract_ending_before = None;
            let mut out = serde_json::Map::new();
            for (name, column, f) in [
                ("status", "e.employment_status", by_status),
                ("employment_type", "p.employment_type", filters.clone()),
                ("legal_entity", "ea.legal_entity_id::text", by_entity),
                ("workplace", "ea.workplace_id::text", by_workplace),
            ] {
                let rows = grouped(column, f).build().fetch_all(tx.as_mut()).await?;
                let facets: Vec<FacetCount> = rows
                    .into_iter()
                    .map(|r| FacetCount { value: r.get("value"), count: r.get("n") })
                    .collect();
                out.insert(name.into(), serde_json::to_value(facets).unwrap());
            }
            let total: i64 = out["employment_type"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["count"].as_i64().unwrap())
                .sum();
            out.insert("total".into(), total.into());
            let window = filters.contract_ending_before;
            let mut review = sqlx::QueryBuilder::<Postgres>::new(
                "SELECT count(*) FILTER (WHERE e.identity_review_required) AS identity, \
                 count(*) FILTER (WHERE cp.employee_id IS NULL) AS branch, \
                 count(*) FILTER (WHERE fe.id IS NOT NULL) AS failed, \
                 count(*) FILTER (WHERE p.contract_end_date < (now() AT TIME ZONE 'Asia/Seoul')::date) AS ended, \
                 count(*) FILTER (WHERE p.contract_end_date < ",
            );
            review.push_bind(window);
            review.push(") AS ending, count(*) FILTER (WHERE ");
            review.push(console_hr_adapter_postgres::register_review_sql!());
            review.push(") AS register_gap");
            let mut by_review = filters.clone();
            by_review.identity_review_required = None;
            by_review.register_review_required = None;
            by_review.home_branch_review_required = None;
            by_review.lifecycle_apply_failed = None;
            by_review.contract_ending_before = None;
            push_filtered_from(&mut review, &by_review);
            let row = review.build().fetch_one(tx.as_mut()).await?;
            out.insert(
                "review".into(),
                json!({
                    "identity_review_required": row.get::<i64, _>("identity"),
                    "register_review_required": row.get::<i64, _>("register_gap"),
                    "home_branch_review_required": row.get::<i64, _>("branch"),
                    "lifecycle_apply_failed": row.get::<i64, _>("failed"),
                    "contract_ended": row.get::<i64, _>("ended"),
                    "contract_ending_before": window.map(|_| row.get::<i64, _>("ending")),
                }),
            );
            Ok(Value::Object(out))
        })
    })
    .await
    .unwrap()
}

pub async fn totals(pool: &PgPool, org: Uuid, filters: EmployeeListFilters) -> (i64, i64) {
    with_org_conn::<_, _, HrError>(pool, OrgId::from_uuid(org), move |tx| {
        Box::pin(async move {
            let full: i64 = filtered_employees("SELECT count(*)", &filters)
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;
            let lean: i64 = counted_employees("SELECT count(*)", &filters)
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;
            Ok((full, lean))
        })
    })
    .await
    .unwrap()
}

pub async fn runtime(pool: &PgPool) -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap()
}

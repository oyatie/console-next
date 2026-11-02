// SPDX-License-Identifier: LicenseRef-Proprietary
//! Observe bulk job and event writes from the owner test pool.
use sqlx::PgPool;
use uuid::Uuid;

async fn count(pool: &PgPool, sql: &'static str, org: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(super) async fn jobs(pool: &PgPool, org: Uuid) -> i64 {
    count(
        pool,
        "SELECT count(*) FROM employee_lifecycle_bulk_jobs WHERE org_id = $1",
        org,
    )
    .await
}

pub(crate) async fn transfers(pool: &PgPool, org: Uuid) -> i64 {
    count(pool, "SELECT count(*) FROM employee_lifecycle_events WHERE org_id = $1 AND event_type = 'TRANSFER'", org).await
}

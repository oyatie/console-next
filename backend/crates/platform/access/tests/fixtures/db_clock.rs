// SPDX-License-Identifier: LicenseRef-Proprietary
//! Fixture clock at PostgreSQL precision for exact timestamp round-trip assertions.

pub async fn db_now(pool: &sqlx::PgPool) -> time::OffsetDateTime {
    sqlx::query_scalar("SELECT now()")
        .fetch_one(pool)
        .await
        .expect("read database clock")
}

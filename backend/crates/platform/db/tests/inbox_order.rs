// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_platform_db::inbox::push_page;
use sqlx::{PgPool, QueryBuilder};
use time::{Duration, OffsetDateTime};

#[sqlx::test(migrations = false)]
async fn deadline_keyset_uses_creation_time_then_id_without_skipping_ties(pool: PgPool) {
    sqlx::query(
        "CREATE TABLE work (id text PRIMARY KEY, due timestamptz, created_at timestamptz NOT NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let at = OffsetDateTime::UNIX_EPOCH;
    for (id, due, created) in [
        ("z", Some(at), at),
        ("a", Some(at), at + Duration::SECOND),
        ("y", None, at),
        ("x", None, at),
        ("b", None, at + Duration::SECOND),
    ] {
        sqlx::query("INSERT INTO work VALUES ($1,$2,$3)")
            .bind(id)
            .bind(due)
            .bind(created)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut after = None;
    let mut ids = Vec::new();
    loop {
        let mut q = QueryBuilder::new("SELECT due, created_at, id FROM work WHERE true");
        push_page(&mut q, "due", "created_at", "id", after, 1);
        let rows: Vec<(Option<OffsetDateTime>, OffsetDateTime, String)> =
            q.build_query_as().fetch_all(&pool).await.unwrap();
        let Some(row) = rows.first() else { break };
        ids.push(row.2.clone());
        after = Some(row.clone());
    }
    assert_eq!(ids, ["z", "a", "x", "y", "b"]);
}

// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! The remembered "not imported" is forgotten only for the header words that
//! had no field to map to, and only where it meant "not imported".
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = false)]
async fn only_the_stale_not_imported_answers_are_forgotten(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(20261111002837000, &pool).await.unwrap();
    let (org, user) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Memory')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, org_id, display_name) VALUES ($1, $2, 'Importer')")
        .bind(user)
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    for (key, target) in [
        ("근무시간", None), // no field could take it: forgotten
        ("특근연장", None),
        ("비고", None),            // a real "not imported": kept
        ("사용연차", None),        // already a field then: a real choice, kept
        ("연장시간", Some("job")), // mapped by the operator: kept
    ] {
        sqlx::query(
            "INSERT INTO import_column_memory (org_id, header_key, target, updated_by) VALUES ($1, $2, $3, $4)",
        )
        .bind(org)
        .bind(key)
        .bind(target)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    }
    migrator.run(&pool).await.unwrap();
    let kept: Vec<String> = sqlx::query_scalar(
        "SELECT header_key FROM import_column_memory WHERE org_id = $1 ORDER BY header_key",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(kept, ["비고", "사용연차", "연장시간"]);
}

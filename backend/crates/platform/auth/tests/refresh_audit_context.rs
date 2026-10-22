// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_auth::{RefreshTokenStore, RefreshTokenUseError};
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

/// One migrator for every `#[sqlx::test]` in this file (expanded once, not per test).
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../db/migrations");

/// Rotation and logout retain their allowed outcome and refresh-family context
/// through the tenant-visible shared writer.
#[sqlx::test(migrator = "MIGRATOR")]
async fn refresh_rotation_and_logout_audit_rows_carry_command_context(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::days(30);
    let absolute_ttl = Duration::days(30);

    let issued = store
        .issue_family(&pool, user_id, OrgId::one(), now, ttl)
        .await
        .unwrap();
    let rotated = store
        .rotate(
            &pool,
            issued.token.as_str(),
            now + Duration::minutes(1),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap();
    store
        .revoke_family_for_logout(&pool, rotated.token.as_str(), now + Duration::minutes(2))
        .await
        .unwrap();

    let rows = audit_rows(&pool).await;
    assert_eq!(
        rows.len(),
        2,
        "rotation and logout each write one audit row"
    );
    for row in &rows {
        assert_context(row, "ALLOWED");
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn refresh_reuse_audit_is_denied(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::days(30);
    let issued = store
        .issue_family(&pool, user_id, OrgId::one(), now, ttl)
        .await
        .unwrap();
    store
        .rotate(
            &pool,
            issued.token.as_str(),
            now + Duration::minutes(1),
            ttl,
            ttl,
        )
        .await
        .unwrap();
    let error = store
        .rotate(
            &pool,
            issued.token.as_str(),
            now + Duration::minutes(2),
            ttl,
            ttl,
        )
        .await
        .unwrap_err();
    assert_eq!(error, RefreshTokenUseError::ReuseDetected);
    assert_refusal(&pool, "auth.refresh.reuse_detected").await;
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn refresh_absolute_ttl_audit_is_denied(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::days(30);
    let issued = store
        .issue_family(&pool, user_id, OrgId::one(), now, ttl)
        .await
        .unwrap();
    let error = store
        .rotate(
            &pool,
            issued.token.as_str(),
            issued.family_created_at + ttl + Duration::seconds(1),
            ttl,
            ttl,
        )
        .await
        .unwrap_err();
    assert_eq!(error, RefreshTokenUseError::FamilyRevoked);
    assert_refusal(&pool, "auth.refresh.absolute_ttl_revoked").await;
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn refresh_idle_timeout_audit_is_denied(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::days(30);
    let issued = store
        .issue_family(&pool, user_id, OrgId::one(), now, ttl)
        .await
        .unwrap();
    let rotated = store
        .rotate(
            &pool,
            issued.token.as_str(),
            issued.family_created_at + Duration::minutes(1),
            ttl,
            ttl,
        )
        .await
        .unwrap();
    let minutes: i32 = sqlx::query_scalar(
        "SELECT idle_timeout_minutes FROM auth_refresh_token_families WHERE id = $1",
    )
    .bind(issued.family_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let error = store
        .rotate(
            &pool,
            rotated.token.as_str(),
            issued.family_created_at + Duration::minutes(i64::from(minutes)) + Duration::seconds(1),
            ttl,
            ttl,
        )
        .await
        .unwrap_err();
    assert_eq!(error, RefreshTokenUseError::IdleExpired);
    assert_refusal(&pool, "auth.session.idle_timeout").await;
}

async fn assert_refusal(pool: &PgPool, action: &str) {
    let rows = audit_rows(pool).await;
    let refused: Vec<_> = rows
        .iter()
        .filter(|row| row.get::<String, _>("action") == action)
        .collect();
    assert_eq!(refused.len(), 1, "{action} writes one durable refusal row");
    assert_context(refused[0], "DENIED");
    for row in rows
        .iter()
        .filter(|row| row.get::<String, _>("action") != action)
    {
        assert_context(row, "ALLOWED");
    }
}

async fn audit_rows(pool: &PgPool) -> Vec<PgRow> {
    let rt = runtime_role_pool(pool).await;
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::one().as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let rows = sqlx::query(
        "SELECT action, source, actor_kind, decision_snapshot, change_mode, outcome, \
         row_hash_version, session_id, target_id::uuid AS family_id \
         FROM audit_events \
         WHERE action IN ('auth.refresh', 'auth.logout', 'auth.refresh.reuse_detected', \
         'auth.refresh.absolute_ttl_revoked', 'auth.session.idle_timeout') ORDER BY action",
    )
    .fetch_all(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    rows
}

fn assert_context(row: &PgRow, expected_outcome: &str) {
    let action: String = row.get("action");
    assert_eq!(
        row.get::<Option<String>, _>("source").as_deref(),
        Some("SYSTEM"),
        "{action} source"
    );
    assert_eq!(
        row.get::<Option<String>, _>("outcome").as_deref(),
        Some(expected_outcome),
        "{action} outcome"
    );
    assert_eq!(
        row.get::<Option<uuid::Uuid>, _>("session_id"),
        Some(row.get::<uuid::Uuid, _>("family_id")),
        "{action} session_id"
    );
    assert_eq!(
        row.get::<Option<String>, _>("actor_kind").as_deref(),
        Some("TENANT_USER"),
        "{action} actor_kind"
    );
    assert!(
        row.get::<Option<serde_json::Value>, _>("decision_snapshot")
            .is_some_and(|value| value.is_object()),
        "{action} context snapshot is null"
    );
    assert!(
        row.get::<Option<String>, _>("change_mode").is_some(),
        "{action} change_mode"
    );
    assert_eq!(
        row.get::<i16, _>("row_hash_version"),
        2,
        "{action} row_hash_version"
    );
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Refresh User")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
    .bind(*OrgId::one().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

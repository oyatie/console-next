// SPDX-License-Identifier: LicenseRef-Proprietary

use super::{MIGRATOR, seed_user};
use console_kernel_core::OrgId;
use console_platform_auth::{RefreshTokenStore, RefreshTokenUseError};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

async fn seed_v1_family(pool: &PgPool, user_id: uuid::Uuid, raw_token: &str) -> uuid::Uuid {
    let family_id = uuid::Uuid::new_v4();
    let token_id = uuid::Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let v1_hash = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, raw_token.as_bytes())
        .as_ref()
        .to_vec();
    sqlx::query(
        "INSERT INTO auth_refresh_token_families (id, user_id, created_at, org_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(family_id)
    .bind(user_id)
    .bind(now)
    .bind(*OrgId::one().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_refresh_tokens (id, family_id, user_id, token_hash, issued_at, expires_at, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(token_id)
    .bind(family_id)
    .bind(user_id)
    .bind(v1_hash)
    .bind(now)
    .bind(now + Duration::days(30))
    .bind(*OrgId::one().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    family_id
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn refresh_token_format_and_redaction(pool: PgPool) {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let user_id = seed_user(&pool).await;
    let issue = RefreshTokenStore
        .issue_family(
            &pool,
            user_id,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::days(30),
        )
        .await
        .unwrap();
    let suffix = issue
        .token
        .as_str()
        .strip_prefix("console_rt_")
        .expect("prefix");
    assert_eq!(suffix.len(), 43);
    assert_eq!(URL_SAFE_NO_PAD.decode(suffix).unwrap().len(), 32);
    let dbg = format!("{:?}", issue.token);
    assert!(!dbg.contains(issue.token.as_str()) && dbg.contains("[REDACTED]"));
    let v1_hash =
        aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, issue.token.as_str().as_bytes())
            .as_ref()
            .to_vec();
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM auth_refresh_tokens WHERE id = $1")
            .bind(issue.token_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(stored, v1_hash);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn legacy_v1_refresh_token_rotates_to_v2_and_detects_reuse(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let v1_token = format!("console_rt_{}", "a".repeat(64));
    let family_id = seed_v1_family(&pool, user_id, &v1_token).await;
    let now = OffsetDateTime::now_utc();
    let rotated = RefreshTokenStore
        .rotate(
            &pool,
            &v1_token,
            now,
            Duration::days(30),
            Duration::days(30),
        )
        .await
        .unwrap();
    assert_eq!(rotated.family_id, family_id);
    assert_eq!(
        rotated
            .token
            .as_str()
            .strip_prefix("console_rt_")
            .unwrap()
            .len(),
        43
    );
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM auth_refresh_tokens WHERE id = $1")
            .bind(rotated.token_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let v1_rep = aws_lc_rs::digest::digest(
        &aws_lc_rs::digest::SHA256,
        rotated.token.as_str().as_bytes(),
    )
    .as_ref()
    .to_vec();
    assert_ne!(stored, v1_rep);
    let reuse = RefreshTokenStore
        .rotate(
            &pool,
            &v1_token,
            now + Duration::seconds(1),
            Duration::days(30),
            Duration::days(30),
        )
        .await
        .unwrap_err();
    assert_eq!(reuse, RefreshTokenUseError::ReuseDetected);
    let after = RefreshTokenStore
        .rotate(
            &pool,
            rotated.token.as_str(),
            now + Duration::seconds(2),
            Duration::days(30),
            Duration::days(30),
        )
        .await
        .unwrap_err();
    assert_eq!(after, RefreshTokenUseError::FamilyRevoked);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn legacy_v1_refresh_token_logout_revokes_family(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let v1_token = format!("console_rt_{}", "b".repeat(64));
    let family_id = seed_v1_family(&pool, user_id, &v1_token).await;
    RefreshTokenStore
        .revoke_family_for_logout(&pool, &v1_token, OffsetDateTime::now_utc())
        .await
        .unwrap();
    let reason: Option<String> =
        sqlx::query_scalar("SELECT revoked_reason FROM auth_refresh_token_families WHERE id = $1")
            .bind(family_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("logout"));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn cross_domain_hash_collision_rejected(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let raw = format!("console_rt_{}", "c".repeat(64));
    let mut ctx = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
    ctx.update(b"console.device_login.v2\0");
    ctx.update(raw.as_bytes());
    let family_id = uuid::Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    sqlx::query(
        "INSERT INTO auth_refresh_token_families (id, user_id, created_at, org_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(family_id)
    .bind(user_id)
    .bind(now)
    .bind(*OrgId::one().as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_refresh_tokens (id, family_id, user_id, token_hash, issued_at, expires_at, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(family_id)
    .bind(user_id)
    .bind(ctx.finish().as_ref().to_vec())
    .bind(now)
    .bind(now + Duration::days(30))
    .bind(*OrgId::one().as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let err = RefreshTokenStore
        .rotate(&pool, &raw, now, Duration::days(30), Duration::days(30))
        .await
        .unwrap_err();
    assert_eq!(err, RefreshTokenUseError::InvalidToken);
}

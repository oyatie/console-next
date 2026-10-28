// SPDX-License-Identifier: LicenseRef-Proprietary
use super::single_use::{redeem, router};
use console_kernel_core::OrgId;
use console_platform_provisioning::{BootstrapCredentialIssue, BootstrapCredentialStore};
use console_platform_test_support::{MIGRATOR, runtime_role_pool, seed_active_user};
use http::StatusCode;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn issue(pool: &PgPool, user: Uuid) -> BootstrapCredentialIssue {
    BootstrapCredentialStore
        .issue_for_zero_credential_user(
            pool,
            None,
            user,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap()
}

async fn user(pool: &PgPool) -> Uuid {
    *seed_active_user(pool, *OrgId::one().as_uuid(), "MEMBER", "OTP holder")
        .await
        .as_uuid()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_code_redeems_once_across_router_instances(pool: PgPool) {
    let user = user(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let code = issue(&runtime, user).await;
    let (status, session) = redeem(router(runtime.clone()), code.token.as_str()).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(session["requires_passkey_setup"], true);
    assert!(
        session["access_token"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    let other = router(runtime);
    for input in [
        code.token.as_str().to_owned(),
        code.token.as_str().replace('-', "").to_ascii_lowercase(),
    ] {
        let (status, replay) = redeem(other.clone(), &input).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{replay}");
        let (status, wrong) = redeem(other.clone(), &Uuid::new_v4().to_string()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(replay["error"]["code"], wrong["error"]["code"]);
        assert_eq!(replay["error"]["message"], wrong["error"]["message"]);
    }
    assert_eq!(session["otp_reusable"], false);
    let state: (Option<OffsetDateTime>, Option<OffsetDateTime>, i64) = sqlx::query_as(
        "SELECT redeemed_at,consumed_at, \
         (SELECT count(*) FROM auth_legacy_otp_family_sources WHERE source_id=b.id) \
         FROM auth_bootstrap_credentials b WHERE id=$1",
    )
    .bind(code.credential_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(state.0.is_some() && state.1.is_none() && state.2 == 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_code_concurrent_redeems_have_exactly_one_winner(pool: PgPool) {
    let user = user(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let code = issue(&runtime, user).await;
    let (a, b) = tokio::join!(
        redeem(router(runtime.clone()), code.token.as_str()),
        redeem(router(runtime), code.token.as_str()),
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 401], "{a:?} {b:?}");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_code_reissue_revokes_unredeemed_code(pool: PgPool) {
    let user = user(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let old = issue(&runtime, user).await;
    let new = issue(&runtime, user).await;
    let service = router(runtime);
    assert_eq!(
        redeem(service.clone(), old.token.as_str()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        redeem(service.clone(), new.token.as_str()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        redeem(service, new.token.as_str()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let reason: String = sqlx::query_scalar(
        "SELECT revoked_reason FROM auth_bootstrap_credentials WHERE id=$1 AND revoked_at IS NOT NULL",
    )
    .bind(old.credential_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reason, "reissued");
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action='auth.bootstrap.issue' AND target_id=$1",
    )
    .bind(user.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 2, "replacement issuance must be audited");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_code_reissue_recovers_interrupted_enrollment(pool: PgPool) {
    let user = user(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let old = issue(&runtime, user).await;
    let service = router(runtime.clone());
    assert_eq!(
        redeem(service.clone(), old.token.as_str()).await.0,
        StatusCode::OK
    );
    let new = issue(&runtime, user).await;
    assert_eq!(
        redeem(service.clone(), old.token.as_str()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(redeem(service, new.token.as_str()).await.0, StatusCode::OK);
    let live_old_families: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_refresh_token_families f \
         JOIN auth_legacy_otp_family_sources s ON s.family_id=f.id \
         WHERE s.source_id=$1 AND f.revoked_at IS NULL",
    )
    .bind(old.credential_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live_old_families, 0);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_code_lifecycle_counts_only_unredeemed_codes(pool: PgPool) {
    let user = user(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let code = issue(&runtime, user).await;
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT code_issued_count FROM platform_tenant_facts($1)")
            .bind(OrgId::one().as_uuid())
            .fetch_one(&runtime)
            .await
            .unwrap()
    };
    assert_eq!(count().await, 1);
    assert_eq!(
        redeem(router(runtime.clone()), code.token.as_str()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        count().await,
        0,
        "a redeemed code cannot be offered as live"
    );
    issue(&runtime, user).await;
    assert_eq!(count().await, 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn admin_code_upgrade_preserves_historical_redemptions_and_unused_codes(pool: PgPool) {
    let redeemed_user = user(&pool).await;
    let unused_user = user(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let redeemed = issue(&runtime, redeemed_user).await;
    let unused = issue(&runtime, unused_user).await;
    let service = router(runtime.clone());
    assert_eq!(
        redeem(service.clone(), redeemed.token.as_str()).await.0,
        StatusCode::OK
    );
    // Model the old writer: accepted audit and family exist, redeemed_at is NULL.
    sqlx::query("UPDATE auth_bootstrap_credentials SET redeemed_at=NULL WHERE id=$1")
        .bind(redeemed.credential_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(
        "ALTER TABLE auth_bootstrap_credentials OWNER TO console_app; \
         ALTER TABLE audit_events OWNER TO console_app; \
         ALTER FUNCTION platform_tenant_facts(UUID) OWNER TO console_app; \
         GRANT CREATE ON SCHEMA public TO console_app; \
         SET LOCAL ROLE console_app",
    )
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../crates/platform/db/migrations/20261029000000001_admin_otp_single_use.sql"
    ))
    .execute(tx.as_mut())
    .await
    .unwrap();
    let forced: bool = sqlx::query_scalar(
        "SELECT bool_and(relforcerowsecurity AND relrowsecurity) FROM pg_class \
         WHERE oid IN ('auth_bootstrap_credentials'::regclass, 'audit_events'::regclass)",
    )
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert!(forced);
    tx.commit().await.unwrap();
    assert_eq!(
        redeem(router(runtime), redeemed.token.as_str()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        redeem(service.clone(), unused.token.as_str()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        redeem(service, unused.token.as_str()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let source: (bool, Option<OffsetDateTime>, Option<OffsetDateTime>, i64) = sqlx::query_as(
        "SELECT single_use,consumed_at,revoked_at, \
         (SELECT count(*) FROM auth_legacy_otp_family_sources s \
          JOIN auth_refresh_token_families f ON f.id=s.family_id \
          WHERE s.source_id=b.id AND f.revoked_at IS NULL) \
         FROM auth_bootstrap_credentials b WHERE id=$1",
    )
    .bind(redeemed.credential_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        source,
        (false, None, None, 1),
        "migration retains the winning enrollment source/family and passkey policy"
    );
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::{
    Router,
    body::{Body, to_bytes},
};
use console_app::{AppState, DatabaseDependency, build_router};
use console_platform_provisioning::BootstrapCredentialStore;
use console_platform_test_support::{MIGRATOR, runtime_role_pool};
use http::{Request, StatusCode};
use p256::{
    ecdsa::SigningKey,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

pub(super) fn router(pool: PgPool) -> Router {
    let key = SigningKey::random(&mut OsRng);
    let mut pairs = super::app_pairs();
    pairs.extend([
        ("CONSOLE_JWT_ISSUER", "console-test".to_owned()),
        ("CONSOLE_JWT_AUDIENCE", "console".to_owned()),
        (
            "CONSOLE_JWT_PRIVATE_KEY_PEM",
            key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        ),
        (
            "CONSOLE_JWT_PUBLIC_KEY_PEM",
            key.verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        ),
        ("CONSOLE_WEBAUTHN_RP_ID", "localhost".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "http://localhost:5173".to_owned(),
        ),
    ]);
    build_router(
        AppState::new(
            super::AppConfig::from_pairs(pairs).unwrap(),
            DatabaseDependency::Postgres(pool),
        )
        .unwrap(),
    )
}

async fn seed(pool: &PgPool, otp: &str) -> bool {
    BootstrapCredentialStore
        .seed_cold_start_credential(pool, otp, Duration::hours(1), OffsetDateTime::now_utc())
        .await
        .unwrap()
}

async fn upgrade_legacy_seeds(pool: &PgPool) {
    let mut tx = pool.begin().await.unwrap();
    // Exercise the production migration owner: neither superuser nor BYPASSRLS.
    sqlx::raw_sql(
        "ALTER TABLE auth_bootstrap_credentials OWNER TO console_app; \
         ALTER TABLE audit_events OWNER TO console_app; SET LOCAL ROLE console_app",
    )
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../crates/platform/db/migrations/20261029000000000_coldstart_single_use.sql"
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
    assert!(forced, "the migration must restore forced RLS");
    tx.commit().await.unwrap();
}

pub(super) async fn redeem(service: Router, otp: &str) -> (StatusCode, Value) {
    let response = service
        .oneshot(
            Request::post("/api/v1/auth/otp/redeem")
                .header("content-type", "application/json")
                .body(Body::from(json!({"otp": otp}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    (
        response.status(),
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap(),
    )
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_redeems_once_across_router_instances(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    let (status, session) = redeem(router(runtime.clone()), &otp).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(session["requires_passkey_setup"], true);
    assert!(
        session["access_token"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    let other = router(runtime);
    let (status, replay) = redeem(other.clone(), &otp).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{replay}");
    assert_eq!(session["otp_reusable"], false);
    let (status, wrong) = redeem(other, &Uuid::new_v4().to_string()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(replay["error"]["code"], "unauthorized");
    assert_eq!(replay["error"]["code"], wrong["error"]["code"]);
    assert_eq!(replay["error"]["message"], wrong["error"]["message"]);
    let families: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_legacy_otp_family_sources")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(families, 1, "a replay must not mint another family");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_concurrent_redeems_have_exactly_one_winner(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    let (a, b) = tokio::join!(
        redeem(router(runtime.clone()), &otp),
        redeem(router(runtime), &otp)
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 401], "{a:?} {b:?}");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_boot_never_revives_a_redeemed_code(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    assert_eq!(
        redeem(router(runtime.clone()), &otp).await.0,
        StatusCode::OK
    );
    assert!(!seed(&runtime, &otp).await);
    assert_eq!(
        redeem(router(runtime.clone()), &otp).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Exercise the UPSERT revival path after an enrollment window expires.
    sqlx::query(
        "UPDATE auth_bootstrap_credentials \
         SET issued_at=clock_timestamp()-interval '2 hours', \
             expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        !seed(&runtime, &otp).await,
        "boot must not reopen a redeemed source"
    );
    assert_eq!(
        redeem(router(runtime), &otp).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_boot_upgrades_an_existing_unredeemed_code(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    sqlx::query("UPDATE auth_bootstrap_credentials SET single_use=false")
        .execute(&pool)
        .await
        .unwrap();
    upgrade_legacy_seeds(&pool).await;
    assert!(!seed(&runtime, &otp).await);
    assert_eq!(
        redeem(router(runtime.clone()), &otp).await.0,
        StatusCode::OK
    );
    assert_eq!(
        redeem(router(runtime), &otp).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_boot_preserves_redemption_from_an_older_replica(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    sqlx::query("UPDATE auth_bootstrap_credentials SET single_use=false")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        redeem(router(runtime.clone()), &otp).await.0,
        StatusCode::OK
    );
    upgrade_legacy_seeds(&pool).await;
    assert!(!seed(&runtime, &otp).await);
    assert_eq!(
        redeem(router(runtime), &otp).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_rotating_boot_secret_preserves_an_older_codes_redemption(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    sqlx::query("UPDATE auth_bootstrap_credentials SET single_use=false")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        redeem(router(runtime.clone()), &otp).await.0,
        StatusCode::OK
    );
    upgrade_legacy_seeds(&pool).await;
    assert!(!seed(&runtime, &Uuid::new_v4().to_string()).await);
    assert_eq!(
        redeem(router(runtime), &otp).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn coldstart_upgrade_preserves_redemption_without_a_boot_secret(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let otp = Uuid::new_v4().to_string();
    assert!(seed(&runtime, &otp).await);
    sqlx::query("UPDATE auth_bootstrap_credentials SET single_use=false")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        redeem(router(runtime.clone()), &otp).await.0,
        StatusCode::OK
    );
    upgrade_legacy_seeds(&pool).await;
    // No seed call: removing the configuration must not leave the old code reusable.
    assert_eq!(
        redeem(router(runtime), &otp).await.0,
        StatusCode::UNAUTHORIZED
    );
}

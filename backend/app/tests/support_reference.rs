// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/reference_logs.rs"]
mod reference_logs;
#[path = "support/http.rs"]
mod support;
use console_app::{AppConfig, AppState, DatabaseDependency, build_router};
use console_kernel_core::UserId;
use http::StatusCode;
use reference_logs::Store;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

async fn ctx(
    pool: &PgPool,
    org: Uuid,
    user: UserId,
    roles: &[&str],
    store: &Store,
) -> support::Ctx {
    let mut ctx = support::ctx(pool, org, user, roles, None).await;
    let keys = support::keys();
    let config = AppConfig::from_pairs([
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
        ("CONSOLE_SUPPORT_LOG_QUERY_URL", store.endpoint.clone()),
    ])
    .unwrap();
    ctx.token = support::token(pool, &keys, org, user, roles).await;
    ctx.service = build_router(
        AppState::new(
            config,
            DatabaseDependency::Postgres(support::role_pool(pool, "console_rt", None).await),
        )
        .unwrap(),
    );
    ctx
}
async fn total_audits(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events")
        .fetch_one(pool)
        .await
        .unwrap()
}
async fn refusal(ctx: &support::Ctx, store: &Store) -> Value {
    let (status, body) = ctx
        .call("GET", "/api/v1/legal-entities/not-a-uuid", None)
        .with_subscriber(store.subscriber())
        .await;
    assert!(status.is_client_error(), "{status}: {body}");
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn server_error_reference_survives_router_restart_and_resolves_the_real_trace(pool: PgPool) {
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let owner = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    sqlx::raw_sql("CREATE FUNCTION fail_support_reference_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private input must not escape'; END $$; CREATE TRIGGER fail_support_reference_test BEFORE INSERT ON legal_entities FOR EACH ROW EXECUTE FUNCTION fail_support_reference_test();").execute(&pool).await.unwrap();
    let before = total_audits(&pool).await;
    let (status, body) = owner
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(support::entity_body()),
        )
        .with_subscriber(store.subscriber())
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    let reference = body["error"]["support_ref"].as_str().unwrap();
    assert_eq!(reference.len(), 32);
    assert_eq!(reference, body["error"]["trace_id"].as_str().unwrap());
    assert!(!body.to_string().contains("private input"));
    // Command admission is existing evidence; response correlation adds no audit event.
    assert_eq!(total_audits(&pool).await, before + 1);
    let fresh = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    let before = total_audits(&pool).await;
    let (status, resolved) = fresh
        .call(
            "GET",
            &format!("/api/v1/support-references/{reference}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["trace_id"], body["error"]["trace_id"]);
    assert_eq!(resolved["route_template"], "/api/v1/legal-entities");
    assert!(resolved["release"].as_str().is_some_and(|r| !r.is_empty()));
    assert_eq!(resolved["support_ref_at"], body["error"]["support_ref_at"]);
    assert_eq!(resolved["support_ref"], reference);
    assert_eq!(resolved["org_id"], org.to_string());
    assert_eq!(support::count(&pool, "legal_entities", org).await, 0);
    assert_eq!(
        total_audits(&pool).await,
        before,
        "{:?}",
        sqlx::query_scalar::<_, String>("SELECT action FROM audit_events ORDER BY created_at")
            .fetch_all(&pool)
            .await
            .unwrap()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_reference_cross_tenant_denied_without_any_audit_side_effect(pool: PgPool) {
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let owner = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    let before = total_audits(&pool).await;
    let body = refusal(&owner, &store).await;
    assert_eq!(
        total_audits(&pool).await,
        before,
        "{:?}",
        sqlx::query_scalar::<_, String>("SELECT action FROM audit_events ORDER BY created_at")
            .fetch_all(&pool)
            .await
            .unwrap()
    );
    let reference = body["error"]["support_ref"].as_str().unwrap();
    let (other_org, other_user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let other = ctx(&pool, other_org, other_user, &["SUPER_ADMIN"], &store).await;
    let before = total_audits(&pool).await;
    let (status, body) = other
        .call(
            "GET",
            &format!("/api/v1/support-references/{reference}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        body["error"]["code"],
        "support_reference_cross_tenant_denied"
    );
    assert_eq!(
        total_audits(&pool).await,
        before,
        "{:?}",
        sqlx::query_scalar::<_, String>("SELECT action FROM audit_events ORDER BY created_at")
            .fetch_all(&pool)
            .await
            .unwrap()
    );
    assert!(body.get("org_id").is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_reference_grant_required_without_query_or_any_audit_side_effect(pool: PgPool) {
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["MEMBER"]).await;
    let caller = ctx(&pool, org, user, &["MEMBER"], &store).await;
    let before = total_audits(&pool).await;
    let (status, body) = caller
        .call(
            "GET",
            "/api/v1/support-references/0123456789abcdef0123456789abcdef",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "support_reference_grant_required");
    assert_eq!(
        total_audits(&pool).await,
        before,
        "{:?}",
        sqlx::query_scalar::<_, String>("SELECT action FROM audit_events ORDER BY created_at")
            .fetch_all(&pool)
            .await
            .unwrap()
    );
    assert_eq!(store.reads.load(std::sync::atomic::Ordering::Relaxed), 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_reference_not_found_and_invalid_input_have_no_audit_side_effect(pool: PgPool) {
    let store = Store::start().await;
    let (org, user) = support::tenant(&pool, &["SUPER_ADMIN"]).await;
    let caller = ctx(&pool, org, user, &["SUPER_ADMIN"], &store).await;
    let before = total_audits(&pool).await;
    for reference in [
        "not-a-reference",
        "00000000000000000000000000000000",
        "0123456789abcdef0123456789abcdef",
    ] {
        let (status, body) = caller
            .call(
                "GET",
                &format!("/api/v1/support-references/{reference}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"]["code"], "support_reference_not_found");
        assert!(body.get("release").is_none());
        assert_eq!(
            total_audits(&pool).await,
            before,
            "{:?}",
            sqlx::query_scalar::<_, String>("SELECT action FROM audit_events ORDER BY created_at")
                .fetch_all(&pool)
                .await
                .unwrap()
        );
    }
    assert_eq!(store.reads.load(std::sync::atomic::Ordering::Relaxed), 1);
}

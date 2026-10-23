// SPDX-License-Identifier: LicenseRef-Proprietary
//! Exercise the lookup with already authenticated platform principals, including restricted grants.
use super::*;
use axum::{body::to_bytes, response::IntoResponse};
use console_platform_authz::PlatformFeature;
use std::{io::Write, sync::atomic::Ordering};
use tracing::instrument::WithSubscriber;

#[path = "../../tests/support/reference_logs.rs"]
mod reference_logs;
use reference_logs::Store;

const REFERENCE: &str = "0123456789abcdef0123456789abcdef";

async fn fixture(pool: &PgPool) -> (AppState, Store, UserId) {
    let store = Store::start().await;
    let config =
        crate::AppConfig::from_pairs([("CONSOLE_SUPPORT_LOG_QUERY_URL", store.endpoint.as_str())])
            .unwrap();
    let state = AppState::new(config, crate::DatabaseDependency::Postgres(pool.clone())).unwrap();
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, org_id, display_name, roles, is_active) VALUES ($1, $2, 'Platform diagnostic test', '{}', true)")
        .bind(user.as_uuid()).bind(OrgId::platform().as_uuid()).execute(pool).await.unwrap();
    let event = json!({"fields": {"message": "support reference", "support_ref": REFERENCE,
        "trace_id": REFERENCE, "release": "tenant-release", "route_template": "/people/:id",
        "org_id": OrgId::one().to_string(), "support_ref_at": "2026-10-22T00:00:00Z"}});
    writeln!(store.logs.clone(), "{event}").unwrap();
    (state, store, user)
}

async fn audit_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_without_tenant_health_read_is_refused_before_querying_or_writing(pool: PgPool) {
    let (state, store, user) = fixture(&pool).await;
    // Serde also proves that an explicit empty capability set survives deserialization.
    let principal: PlatformPrincipal =
        serde_json::from_value(json!({"user_id": user, "features": []})).unwrap();
    let before = audit_count(&pool).await;
    let response = resolve_platform(State(state), Extension(principal), Path(REFERENCE.into()))
        .with_subscriber(store.subscriber())
        .await
        .into_response();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "support_reference_grant_required");
    assert!(body.get("org_id").is_none());
    assert_eq!(store.reads.load(Ordering::Relaxed), 0);
    assert_eq!(audit_count(&pool).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_with_tenant_health_read_resolves_another_tenants_reference(pool: PgPool) {
    let (state, store, user) = fixture(&pool).await;
    let principal: PlatformPrincipal = serde_json::from_value(
        json!({"user_id": user, "features": [PlatformFeature::TenantHealthRead]}),
    )
    .unwrap();
    let before = audit_count(&pool).await;
    let resolved = resolve_platform(State(state), Extension(principal), Path(REFERENCE.into()))
        .with_subscriber(store.subscriber())
        .await
        .unwrap()
        .0;
    assert_eq!(resolved["org_id"], OrgId::one().to_string());
    assert_ne!(resolved["org_id"], OrgId::platform().to_string());
    assert_eq!(resolved["trace_id"], REFERENCE);
    assert_eq!(resolved["route_template"], "/people/:id");
    assert_eq!(resolved["release"], "tenant-release");
    assert_eq!(store.reads.load(Ordering::Relaxed), 1);
    assert_eq!(audit_count(&pool).await, before);
}

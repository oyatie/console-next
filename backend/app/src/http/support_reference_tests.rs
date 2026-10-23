// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use super::*;

use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{EffectiveFeatureGrant, PermissionLevel};

#[cfg(feature = "test-postgres")]
#[path = "support_reference_platform_tests.rs"]
mod platform;
#[test]
fn diagnostic_grant_comes_from_tenant_configuration_without_a_support_role() {
    let org = OrgId::new();
    let principal = Principal::new(UserId::new(), org, Default::default(), BranchScope::All)
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::AuditLogRead,
            PermissionLevel::Allow,
            BranchScope::All,
        )]);
    let grant = authorize_org_wide(&principal, Action::new(Feature::AuditLogRead)).is_ok();
    assert!(authorize(&principal.user_id.to_string(), org, org, grant).is_ok());
}
// Split test sources are also read independently by the route census.
#[cfg(test)]
#[tokio::test]
async fn errors_and_beacon_references_never_acquire_the_unavailable_database() {
    use axum::{
        body::{Body, to_bytes},
        http::Request,
        middleware,
        routing::get,
    };
    use tower::ServiceExt;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_secs(1))
        .connect_lazy("postgres://unavailable@127.0.0.1:1/none")
        .unwrap();
    let config = crate::AppConfig::from_pairs(std::iter::empty::<(&str, &str)>()).unwrap();
    let state = AppState::new(config, crate::DatabaseDependency::Postgres(pool)).unwrap();
    for status in [401, 403, 429, 503, 500] {
        let status = StatusCode::from_u16(status).unwrap();
        let app = Router::new()
            .route(
                "/failure",
                get(move || async move {
                    (
                        status,
                        Json(json!({"error": {"code": "internal", "message": "private detail"}})),
                    )
                }),
            )
            .layer(middleware::from_fn_with_state(
                state.clone(),
                super::super::redact::redact,
            ))
            .layer(middleware::from_fn(crate::telemetry::with_trace_context));
        let response = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            app.oneshot(
                Request::builder()
                    .uri("/failure")
                    .body(Body::empty())
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(
            response.headers()["content-type"],
            "application/problem+json"
        );
        let header = response.headers()["support-ref"]
            .to_str()
            .unwrap()
            .to_owned();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["error"]["support_ref"], body["error"]["trace_id"]);
        assert_eq!(body["error"]["support_ref"], header);
        assert_eq!(header.len(), 32);
    }
    let app = Router::new().route(
        "/api/v1/client-errors",
        super::super::client_errors::post(&state),
    );
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/client-errors")
                .header("accept", "application/json")
                .body(Body::from(
                    r#"{"kind":"reference","build":"dev","route":"/"}"#,
                ))
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
}

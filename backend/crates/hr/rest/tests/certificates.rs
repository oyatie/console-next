// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Every certificate HTTP door refuses a lower grant before it can write a register row.
use axum::{
    Extension,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_hr_adapter_postgres::HrService;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use tower::ServiceExt;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_route_returns_a_coded_refusal_with_a_support_reference(pool: PgPool) {
    let org = OrgId::new();
    seed_org_and_super_admin(&pool, *org.as_uuid(), "certificate-http").await;
    let lower = Principal::new(
        UserId::new(),
        org,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    );
    let router =
        console_hr_rest::certificates::router(HrService::new(runtime_role_pool(&pool).await))
            .layer(Extension(lower));
    let id = Uuid::new_v4();
    for (method, path, body) in [
        ("GET", "/api/v1/hr/certificates".to_owned(), None),
        (
            "POST",
            "/api/v1/hr/certificates".to_owned(),
            Some(json!({"employee_id":id,"kind":"CAREER","items":["period"],"purpose":"제출용"})),
        ),
        ("GET", format!("/api/v1/hr/certificates/{id}"), None),
        (
            "POST",
            format!("/api/v1/hr/certificates/{id}/void"),
            Some(json!({"reason":"시험"})),
        ),
        (
            "POST",
            format!("/api/v1/hr/certificates/{id}/reissue"),
            Some(json!({"reason":"시험"})),
        ),
        ("GET", "/api/v1/hr/certificate-settings".into(), None),
        (
            "PUT",
            "/api/v1/hr/certificate-settings".into(),
            Some(
                json!({"legal_entity_id":id,"prefix":"TEST","width":6,"seal_text":"시험 대표","expected_version":0}),
            ),
        ),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(&path)
            .header("Content-Type", "application/json")
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .body(Body::from(
                body.map_or(String::new(), |body| body.to_string()),
            ))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["error"]["code"], "certificate_forbidden");
        assert!(Uuid::parse_str(body["error"]["trace_id"].as_str().unwrap()).is_ok());
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM hr_certificates WHERE org_id=$1")
        .bind(org.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn precondition_http_returns_only_readiness_and_refuses_an_ungranted_actor(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "certificate-precondition").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,hire_date,source_filename,source_sheet,source_row,source_key) VALUES($1,'Employer','Employee','2020-01-01','test','test',1,$2) RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
    let lower = UserId::new();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Unassigned',ARRAY['MEMBER'])")
        .bind(lower.as_uuid()).bind(org.as_uuid()).execute(&pool).await.unwrap();
    let hr = HrService::new(runtime_role_pool(&pool).await);
    for (user, role, status) in [
        (actor, Role::SuperAdmin, StatusCode::OK),
        (lower, Role::Member, StatusCode::FORBIDDEN),
    ] {
        let p = Principal::new(user, org, BTreeSet::from([role]), BranchScope::All);
        let router = console_hr_rest::certificates::router(hr.clone()).layer(Extension(p));
        let request = Request::builder()
            .uri(format!(
                "/api/v1/hr/certificates/precondition?employee_id={employee}"
            ))
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), status);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        if status == StatusCode::OK {
            assert_eq!(
                body,
                json!({"settings_configured":false,"reason_code":"certificate_facts_missing"})
            );
        } else {
            assert_eq!(body["error"]["code"], "certificate_forbidden");
        }
    }
}

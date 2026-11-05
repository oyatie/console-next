// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Access-request writes retain their live-account and support-session boundaries.
mod support;

use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use support::{World, world};

async fn rows(w: &World, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM {table} WHERE org_id = $1"
    )))
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

/// The request's own audit rows (a refused call may log its denial elsewhere).
async fn request_audits(w: &World) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action LIKE 'access.request.%'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

const REQUESTS: &str = "/api/v1/access/requests";

fn principal(
    w: &World,
    user: console_kernel_core::UserId,
    support: bool,
) -> console_platform_authz::Principal {
    let mut p = console_platform_authz::Principal::new(
        user,
        console_kernel_core::OrgId::from_uuid(w.org),
        Default::default(),
        console_kernel_core::BranchScope::All,
    );
    if support {
        p.support = Some(
            serde_json::from_value(json!({
                "active": true, "org_id": w.org, "operator_approved": true,
                "tenant_approved": true, "session_id": uuid::Uuid::new_v4(),
                "operator_label": "operator", "scope": [], "reveal_classes": []
            }))
            .unwrap(),
        );
    }
    p
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_session_cannot_file_an_access_request(pool: PgPool) {
    let w = world(pool).await;
    let service = console_platform_access::AccessService::new(w.rt.clone(), None);
    let body =
        serde_json::from_value(json!({"screen": "/people", "reason_code": "NEW_DUTY"})).unwrap();
    let error =
        console_platform_access::requests::create(&service, principal(&w, w.hr, true), body)
            .await
            .unwrap_err();
    assert_eq!(
        (error.kind, error.code),
        (console_platform_access::Refusal::Forbidden, "access_denied")
    );
    assert_eq!(rows(&w, "access_requests").await, 0);
    assert_eq!(request_audits(&w).await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_session_cannot_close_an_access_request(pool: PgPool) {
    let w = world(pool).await;
    let (status, request) = w
        .call(
            Method::POST,
            REQUESTS,
            w.hr,
            Some(json!({"screen": "/people", "reason_code": "NEW_DUTY"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{request}");
    let id = request["id"].as_str().unwrap().parse().unwrap();
    let service = console_platform_access::AccessService::new(w.rt.clone(), None);
    for (user, status) in [(w.hr, "WITHDRAWN"), (w.ops, "DONE"), (w.ops, "DECLINED")] {
        let body = serde_json::from_value(json!({"status": status})).unwrap();
        let error =
            console_platform_access::requests::close(&service, principal(&w, user, true), id, body)
                .await
                .unwrap_err();
        assert_eq!(
            (error.kind, error.code),
            (console_platform_access::Refusal::Forbidden, "access_denied")
        );
    }
    let state: String = sqlx::query_scalar("SELECT status FROM access_requests WHERE id = $1")
        .bind(id)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(state, "OPEN");
    assert_eq!(request_audits(&w).await, 1);
    let (status, withdrawn) = w
        .call(
            Method::POST,
            &format!("{REQUESTS}/{id}/close"),
            w.hr,
            Some(json!({"status": "WITHDRAWN"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{withdrawn}");
    assert_eq!(withdrawn["status"], "WITHDRAWN");
    assert_eq!(request_audits(&w).await, 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inactive_account_cannot_file_an_access_request(pool: PgPool) {
    let w = world(pool).await;
    let (status, request) = w
        .call(
            Method::POST,
            REQUESTS,
            w.hr,
            Some(json!({"screen": "/people", "reason_code": "NEW_DUTY"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{request}");
    let id = request["id"].as_str().unwrap().parse().unwrap();
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(w.hr.as_uuid())
        .execute(&w.owner)
        .await
        .unwrap();
    let service = console_platform_access::AccessService::new(w.rt.clone(), None);
    let body =
        serde_json::from_value(json!({"screen": "/people", "reason_code": "NEW_DUTY"})).unwrap();
    let error =
        console_platform_access::requests::create(&service, principal(&w, w.hr, false), body)
            .await
            .unwrap_err();
    assert_eq!(
        (error.kind, error.code),
        (console_platform_access::Refusal::Forbidden, "forbidden")
    );
    let body = serde_json::from_value(json!({"status": "WITHDRAWN"})).unwrap();
    let error =
        console_platform_access::requests::close(&service, principal(&w, w.hr, false), id, body)
            .await
            .unwrap_err();
    assert_eq!(
        (error.kind, error.code),
        (console_platform_access::Refusal::Forbidden, "forbidden")
    );
    assert_eq!(rows(&w, "access_requests").await, 1);
    assert_eq!(request_audits(&w).await, 1);
}

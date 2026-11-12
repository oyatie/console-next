// SPDX-License-Identifier: LicenseRef-Proprietary
#![cfg(feature = "workspace")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real request items must remain displayable in every inbox consumer.

#[path = "workbench_native_api/http.rs"]
mod native_http;
#[path = "period_unlock_support/mod.rs"]
mod period_support;

use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn change_request_keeps_workbench_action_list_available(pool: PgPool) {
    let (service, issuer) = period_support::router(&pool).await;
    let svc = passkey_service();
    let requester = period_support::admin(&pool, &svc, &issuer, "정정 요청자").await;
    let approver = period_support::admin(&pool, &svc, &issuer, "정정 승인자").await;
    let employee: Uuid = sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
        .bind(approver.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (status, request) = period_support::send(
        &service,
        "/api/v1/change-requests",
        &requester.token,
        Some(&Uuid::new_v4().to_string()),
        json!({"kind":"PROFILE_CORRECTION", "subject_type":"EMPLOYEE", "subject_id":employee,
            "payload":{"changes":{"name":"정정 후 이름"}}, "reason_code":"DATA_ENTRY_ERROR", "note":"정정 요청 확인"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{request}");
    assert_action(
        service,
        &approver.token,
        &format!("hr_request:{}", request["id"].as_str().unwrap()),
        "정정 승인자",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unlock_request_has_one_task_surface_and_only_eligible_approvers_can_decide(pool: PgPool) {
    let (service, issuer) = period_support::router(&pool).await;
    let svc = passkey_service();
    let mut requester = period_support::admin(&pool, &svc, &issuer, "해제 요청자").await;
    let approver = period_support::admin(&pool, &svc, &issuer, "해제 승인자").await;
    let (status, lock) = period_support::send(&service, period_support::LOCKS, &requester.token, None,
        json!({"domain":"payroll","periodStart":"2026-06-01","periodEnd":"2026-06-30","reasonCode":"MONTHLY_PAYROLL_CLOSE"})).await;
    assert_eq!(status, StatusCode::CREATED, "{lock}");
    let lock: Uuid = lock["id"].as_str().unwrap().parse().unwrap();
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(3))
        .format(&Rfc3339)
        .unwrap();
    let reason = "RETRO_CORRECTION";
    let step_up = period_support::step_up(
        &pool,
        &svc,
        &mut requester,
        lock,
        &format!("PERIOD_UNLOCK\n{lock}\n{reason}\n{relock_at}"),
    )
    .await;
    let (status, pending) = period_support::send(
        &service,
        &format!("{}/{lock}/unlock", period_support::LOCKS),
        &requester.token,
        None,
        json!({"reasonCode":reason,"note":"소급 정정 확인","relockAt":relock_at,"stepUp":step_up}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
    let request = pending["request"]["id"].as_str().unwrap();
    let item_id = format!("period_unlock:{request}");
    assert_action(service.clone(), &approver.token, &item_id, "해제 요청자").await;
    let queue = native_http::get(service.clone(), "/api/v1/me/action-inbox", &approver.token).await;
    assert_eq!(queue.status, StatusCode::OK, "{}", queue.json);
    assert!(
        queue.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == item_id)
    );
    let before = queue.json["counts"]["turn"]["total"].as_u64().unwrap();
    let own = native_http::get(service.clone(), "/api/v1/me/action-inbox", &requester.token).await;
    assert_eq!(own.status, StatusCode::OK, "{}", own.json);
    assert!(
        own.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != item_id)
    );
    let reject = format!("{}/{lock}/unlock/reject", period_support::LOCKS);
    let (status, refused) = period_support::send(
        &service,
        &reject,
        &requester.token,
        None,
        json!({"requestId":request,"note":"본인 반려"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "second_person_required");
    let (status, decided) = period_support::send(
        &service,
        &reject,
        &approver.token,
        None,
        json!({"requestId":request,"note":"정정 근거 보완"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decided}");
    let after = native_http::get(service.clone(), "/api/v1/me/action-inbox", &approver.token).await;
    assert_eq!(after.status, StatusCode::OK, "{}", after.json);
    assert!(
        after.json["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != item_id)
    );
    assert_eq!(after.json["counts"]["turn"]["total"], before - 1);
    let (status, locks) =
        period_support::read(&service, period_support::LOCKS, &approver.token).await;
    assert_eq!(status, StatusCode::OK, "{locks}");
    assert!(
        locks.get("soleHolderNotices").is_none(),
        "inbox owns task counts: {locks}"
    );
}

async fn assert_action(service: axum::Router, token: &str, id: &str, title: &str) {
    let response = native_http::get(service, "/api/v1/me/workbench", token).await;
    assert_eq!(response.status, StatusCode::OK, "{:?}", response.json);
    let actions = &response.json["action_inbox"];
    assert_eq!(actions["status"], "ok", "{actions}");
    let item = actions["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .expect("the request stays available alongside the other work");
    assert_eq!(item["title"], title);
    assert_eq!(item["source"]["id"], id.rsplit_once(':').unwrap().1);
    assert!(!item["target"]["module"].as_str().unwrap().is_empty());
}

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-15 second-person decision through the router: the lock list carries the
//! waiting request and who may decide it; the second person refuses it with a
//! note (반려) or approves the request they reviewed; every refusal code —
//! the requester's own person (Cedar independent_people), an ineligible
//! holder, a lower grant, another tenant, a replaced or expired request, a
//! blank note — leaves the lock and the request untouched.

mod period_unlock_support;

use axum::body::{Body, to_bytes};
use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::passkey_service;
use http::{Request, StatusCode, header};
use period_unlock_support::{Admin, LOCKS, admin, admin_in, router, send, session_token, step_up};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

async fn list(service: &axum::Router, token: &str) -> Vec<Value> {
    let response = service
        .clone()
        .oneshot(
            Request::builder()
                .uri(LOCKS)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    body["items"].as_array().unwrap().clone()
}

async fn request_of(service: &axum::Router, token: &str, lock_id: Uuid) -> Value {
    list(service, token)
        .await
        .into_iter()
        .find(|lock| lock["id"] == lock_id.to_string())
        .unwrap()["unlockRequest"]
        .clone()
}

async fn lock(service: &axum::Router, who: &Admin, month: &str) -> Uuid {
    let body = json!({"domain": "payroll", "periodStart": format!("2026-{month}-01"),
                      "periodEnd": format!("2026-{month}-28"), "reasonCode": "MONTHLY_PAYROLL_CLOSE"});
    let (status, locked) = send(service, LOCKS, &who.token, None, body).await;
    assert_eq!(status, StatusCode::CREATED, "{locked}");
    locked["id"].as_str().unwrap().parse().unwrap()
}

async fn request(
    service: &axum::Router,
    owner: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    who: &mut Admin,
    lock_id: Uuid,
) -> Uuid {
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(3))
        .format(&Rfc3339)
        .unwrap();
    let payload = format!("PERIOD_UNLOCK\n{lock_id}\nPAYROLL_ERROR\n{relock_at}");
    let body = json!({"reasonCode": "PAYROLL_ERROR", "note": "8월 급여 재계산", "relockAt": relock_at,
                      "stepUp": step_up(owner, svc, who, lock_id, &payload).await});
    let (status, pending) = send(
        service,
        &format!("{LOCKS}/{lock_id}/unlock"),
        &who.token,
        None,
        body,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
    pending["request"]["id"].as_str().unwrap().parse().unwrap()
}

async fn reject(
    service: &axum::Router,
    token: &str,
    lock_id: Uuid,
    request_id: Uuid,
    note: &str,
) -> (StatusCode, Value) {
    let body = json!({"requestId": request_id, "note": note});
    send(
        service,
        &format!("{LOCKS}/{lock_id}/unlock/reject"),
        token,
        None,
        body,
    )
    .await
}

async fn approve(
    service: &axum::Router,
    owner: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    who: &mut Admin,
    lock_id: Uuid,
    request_id: Uuid,
) -> (StatusCode, Value) {
    let payload = format!("PERIOD_UNLOCK_APPROVE\n{request_id}");
    let body = json!({"requestId": request_id, "stepUp": step_up(owner, svc, who, request_id, &payload).await});
    send(
        service,
        &format!("{LOCKS}/{lock_id}/unlock/approve"),
        &who.token,
        None,
        body,
    )
    .await
}

/// The lock is in force and its request undecided: a refusal changed nothing.
async fn untouched(owner: &PgPool, lock_id: Uuid, request_id: Uuid) {
    let (unlocked, outcome, decisions): (bool, Option<String>, i64) = sqlx::query_as(
        "SELECT l.unlocked_at IS NOT NULL, r.outcome, \
                (SELECT count(*) FROM audit_events a WHERE a.target_id = l.id::text \
                   AND a.action IN ('period_lock.unlock', 'period_lock.unlock_reject')) \
         FROM period_locks l JOIN period_unlock_requests r ON r.lock_id = l.id \
         WHERE l.id = $1 AND r.id = $2",
    )
    .bind(lock_id)
    .bind(request_id)
    .fetch_one(owner)
    .await
    .unwrap();
    assert_eq!((unlocked, outcome, decisions), (false, None, 0));
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_second_person_refuses_with_a_note_and_every_refusal_leaves_no_trace(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let mut requester = admin(&owner, &svc, &issuer, "요청자").await;
    let decider = admin(&owner, &svc, &issuer, "결정자").await;
    let lock_id = lock(&service, &requester, "06").await;
    let request_id = request(&service, &owner, &svc, &mut requester, lock_id).await;

    // The list shows the waiting request; only the second person may decide it.
    let seen = request_of(&service, &requester.token, lock_id).await;
    assert_eq!(seen["id"], request_id.to_string(), "{seen}");
    assert_eq!(seen["status"], "PENDING");
    assert_eq!(seen["requestedByName"], "요청자");
    assert_eq!(seen["reasonNote"], "8월 급여 재계산");
    assert_eq!(seen["canDecide"], false);
    assert_eq!(
        request_of(&service, &decider.token, lock_id).await["canDecide"],
        true
    );

    // The requester's own person: refused by Cedar (independent_people).
    let (status, body) = reject(&service, &requester.token, lock_id, request_id, "취소").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "second_person_required"),
        "{body}"
    );

    // An account holding the feature but not eligible (no employee link, not ops).
    let unlinked = admin(&owner, &svc, &issuer, "연결 없음").await;
    sqlx::query("UPDATE users SET employee_id = NULL WHERE id = $1")
        .bind(unlinked.id)
        .execute(&owner)
        .await
        .unwrap();
    let (status, body) = reject(&service, &unlinked.token, lock_id, request_id, "반려").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "second_person_ineligible"),
        "{body}"
    );

    // A lower grant: no close authority at all.
    let lower_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ('접수 담당', ARRAY['RECEPTIONIST'], $1) RETURNING id",
    )
    .bind(OrgId::one().as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    let lower = session_token(&owner, &issuer, OrgId::one(), lower_id, "RECEPTIONIST").await;
    let (status, body) = reject(&service, &lower, lock_id, request_id, "반려").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Another tenant's close authority sees no such request.
    let other = OrgId::new();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '다른 회사')")
        .bind(other.as_uuid())
        .bind(format!("other-{}", other.as_uuid().simple()))
        .execute(&owner)
        .await
        .unwrap();
    let mut foreign = admin_in(&owner, &svc, &issuer, other, "다른 회사 결정자").await;
    let (status, body) = reject(&service, &foreign.token, lock_id, request_id, "반려").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = approve(&service, &owner, &svc, &mut foreign, lock_id, request_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    // A blank note.
    let (status, body) = reject(&service, &decider.token, lock_id, request_id, "   ").await;
    assert_eq!(
        (status, code(&body)),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "period_unlock_reject_note_invalid"
        ),
        "{body}"
    );
    untouched(&owner, lock_id, request_id).await;

    // The second person refuses: the lock stays in force; the requester reads who and why.
    // regression: the refusal's Idempotency-Key was refused by the operation CHECK (500); it records and replays.
    let refusal = json!({"requestId": request_id, "note": "  9월 마감 뒤 다시 요청  "});
    let uri = format!("{LOCKS}/{lock_id}/unlock/reject");
    let key = Some("unlock-reject-key-0001");
    let (status, body) = send(&service, &uri, &decider.token, key, refusal.clone()).await;
    let (again, replay) = send(&service, &uri, &decider.token, key, refusal).await;
    assert_eq!((again, &replay), (StatusCode::OK, &body), "{replay}");
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (body["status"].as_str(), body["lock"]["active"].as_bool()),
        (Some("REJECTED"), Some(true))
    );
    let seen = request_of(&service, &requester.token, lock_id).await;
    assert_eq!(seen["status"], "REJECTED", "{seen}");
    assert_eq!(seen["decidedByName"], "결정자");
    assert_eq!(seen["decisionNote"], "9월 마감 뒤 다시 요청");
    assert_eq!(seen["canDecide"], false);
    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action = 'period_lock.unlock_reject' AND target_id = $1",
    )
    .bind(lock_id.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audit["request_id"], request_id.to_string(), "{audit}");
    assert_eq!(audit["second_person"], "eligible");

    // Every close authority's lock list and Home learn of the request and the refusal (realtime topic).
    let topics: Vec<String> = sqlx::query_scalar(
        "SELECT a.action FROM resource_changes c JOIN audit_events a ON a.id = c.audit_event_id \
         WHERE c.resource_type = 'period_lock' AND c.resource_id = $1 ORDER BY c.seq",
    )
    .bind(lock_id.to_string())
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(
        topics,
        [
            "period_lock.lock",
            "period_lock.unlock_request",
            "period_lock.unlock_reject"
        ]
    );

    // Decided once: nothing is waiting any more.
    let (status, body) = reject(&service, &decider.token, lock_id, request_id, "다시").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_replaced_or_expired_request_is_refused_and_the_reviewed_one_is_approved(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let mut requester = admin(&owner, &svc, &issuer, "요청자").await;
    let mut approver = admin(&owner, &svc, &issuer, "승인자").await;
    let lock_id = lock(&service, &requester, "06").await;
    let first = request(&service, &owner, &svc, &mut requester, lock_id).await;
    let second = request(&service, &owner, &svc, &mut requester, lock_id).await;

    // The approver reviewed the first request; a newer one replaced it.
    let (status, body) = approve(&service, &owner, &svc, &mut approver, lock_id, first).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "period_unlock_request_changed"),
        "{body}"
    );
    let (status, body) = reject(&service, &approver.token, lock_id, first, "반려").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "period_unlock_request_changed"),
        "{body}"
    );
    untouched(&owner, lock_id, second).await;

    // An open request past its window reads as expired and cannot be decided.
    let stale_lock = lock(&service, &requester, "07").await;
    let stale: Uuid = sqlx::query_scalar(
        "INSERT INTO period_unlock_requests (org_id, lock_id, requested_by, reason_code, relock_at, \
                                             step_up_assertion_id, requested_at) \
         VALUES ($1, $2, $3, 'PAYROLL_ERROR', now() - interval '1 hour', gen_random_uuid(), \
                 now() - interval '2 hours') RETURNING id",
    )
    .bind(OrgId::one().as_uuid())
    .bind(stale_lock)
    .bind(requester.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    let seen = request_of(&service, &approver.token, stale_lock).await;
    assert_eq!(
        (seen["status"].as_str(), seen["canDecide"].as_bool()),
        (Some("EXPIRED"), Some(false)),
        "{seen}"
    );
    let (status, body) = approve(&service, &owner, &svc, &mut approver, stale_lock, stale).await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "period_unlock_request_expired"),
        "{body}"
    );
    let (status, body) = reject(&service, &approver.token, stale_lock, stale, "반려").await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "period_unlock_request_expired"),
        "{body}"
    );
    untouched(&owner, stale_lock, stale).await;

    // The request the approver reviewed: approved, and the list says so.
    let (status, body) = approve(&service, &owner, &svc, &mut approver, lock_id, second).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["lock"]["active"], false);
    let seen = request_of(&service, &requester.token, lock_id).await;
    assert_eq!(
        (seen["status"].as_str(), seen["decidedByName"].as_str()),
        (Some("APPROVED"), Some("승인자")),
        "{seen}"
    );
}

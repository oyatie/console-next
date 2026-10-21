#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Decisions #26 item d through the router: when an unlock waits for a second
//! person, the tenant ops account may be that person (break-glass: its own
//! step-up, flagged for review, audited). Anyone else who is not an eligible
//! holder is still refused with no side effect, and ops never approves its
//! own request.

mod period_unlock_support;

use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{Admin, LOCKS, admin, router, send, step_up};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// A SUPER_ADMIN with no employee link: never an eligible second person
/// (`NO_EMPLOYEE_LINK`); `ops` marks it the tenant ops account.
async fn unlinked(
    owner: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    issuer: &console_platform_auth::JwtIssuer,
    name: &str,
    ops: bool,
) -> Admin {
    let who = admin(owner, svc, issuer, name).await;
    sqlx::query("UPDATE users SET employee_id = NULL, is_tenant_ops = $2 WHERE id = $1")
        .bind(who.id)
        .bind(ops)
        .execute(owner)
        .await
        .unwrap();
    who
}

async fn lock_and_request(
    service: &axum::Router,
    owner: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    who: &mut Admin,
    month: &str,
) -> (Uuid, Uuid) {
    let lock = json!({"domain": "payroll", "periodStart": format!("2026-{month}-01"),
                      "periodEnd": format!("2026-{month}-28"), "reasonCode": "MONTHLY_PAYROLL_CLOSE"});
    let (status, locked) = send(service, LOCKS, &who.token, None, lock).await;
    assert_eq!(status, StatusCode::CREATED, "{locked}");
    let lock_id: Uuid = locked["id"].as_str().unwrap().parse().unwrap();
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(3))
        .format(&Rfc3339)
        .unwrap();
    let payload = format!("PERIOD_UNLOCK\n{lock_id}\nPAYROLL_ERROR\n{relock_at}");
    let body = json!({"reasonCode": "PAYROLL_ERROR", "relockAt": relock_at,
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
    assert_eq!(pending["status"], "PENDING_SECOND_PERSON");
    (
        lock_id,
        pending["request"]["id"].as_str().unwrap().parse().unwrap(),
    )
}

async fn approve(
    service: &axum::Router,
    owner: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    who: &mut Admin,
    lock_id: Uuid,
    request_id: Uuid,
    with_step_up: bool,
) -> (StatusCode, Value) {
    let body = if with_step_up {
        let payload = format!("PERIOD_UNLOCK_APPROVE\n{request_id}");
        json!({"stepUp": step_up(owner, svc, who, request_id, &payload).await})
    } else {
        json!({})
    };
    send(
        service,
        &format!("{LOCKS}/{lock_id}/unlock/approve"),
        &who.token,
        None,
        body,
    )
    .await
}

async fn unlocks(owner: &PgPool, lock_id: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action = 'period_lock.unlock' AND target_id = $1",
    )
    .bind(lock_id.to_string())
    .fetch_all(owner)
    .await
    .unwrap()
}

async fn active(owner: &PgPool, lock_id: Uuid) -> bool {
    sqlx::query_scalar("SELECT period_lock_effective(period_locks) FROM period_locks WHERE id = $1")
        .bind(lock_id)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// regression (decisions #26 item d): before it, ops was refused
/// `second_person_ineligible` and an unlock waiting on an absent holder could
/// not be performed by anyone in the tenant.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_d26_ops_is_the_second_person_only_with_a_step_up_and_never_for_itself(
    owner: PgPool,
) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let mut requester = admin(&owner, &svc, &issuer, "요청자").await;
    let _absent = admin(&owner, &svc, &issuer, "부재자").await;
    let mut ops = unlinked(&owner, &svc, &issuer, "운영 관리자", true).await;
    let mut outsider = unlinked(&owner, &svc, &issuer, "외부자", false).await;
    let (lock_id, request_id) =
        lock_and_request(&service, &owner, &svc, &mut requester, "06").await;

    // Negative: a non-ops account that is not an eligible holder stays refused.
    let (status, refused) = approve(
        &service,
        &owner,
        &svc,
        &mut outsider,
        lock_id,
        request_id,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"], "second_person_ineligible",
        "{refused}"
    );
    // Negative: ops without its own step-up is refused.
    let (status, refused) =
        approve(&service, &owner, &svc, &mut ops, lock_id, request_id, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{refused}");
    assert_eq!(
        refused["error"]["code"], "passkey_step_up_required",
        "{refused}"
    );
    // No side effect from either refusal.
    assert!(active(&owner, lock_id).await);
    assert!(unlocks(&owner, lock_id).await.is_empty());

    // Ops with its own step-up performs it, flagged for review and audited.
    let (status, unlocked) =
        approve(&service, &owner, &svc, &mut ops, lock_id, request_id, true).await;
    assert_eq!(status, StatusCode::OK, "{unlocked}");
    assert_eq!(unlocked["lock"]["active"], false);
    assert_eq!(unlocked["lock"]["unlockedBy"], requester.id.to_string());
    assert_eq!(unlocked["lock"]["unlockApprovedBy"], ops.id.to_string());
    assert_eq!(unlocked["lock"]["unlockReviewRequired"], true);
    let audits = unlocks(&owner, lock_id).await;
    assert_eq!(audits.len(), 1, "{audits:?}");
    assert_eq!(audits[0]["second_person"], "ops_break_glass");
    assert_eq!(audits[0]["review_required"], true);
    assert!(audits[0]["step_up_assertion_id"].is_string(), "{audits:?}");

    // Negative: ops is never the second person of its own request.
    let (own_lock, own_request) = lock_and_request(&service, &owner, &svc, &mut ops, "07").await;
    let (status, refused) = approve(
        &service,
        &owner,
        &svc,
        &mut ops,
        own_lock,
        own_request,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"], "second_person_required",
        "{refused}"
    );
    assert!(active(&owner, own_lock).await);
    assert!(unlocks(&owner, own_lock).await.is_empty());
}

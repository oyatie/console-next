#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Unbound operations accounts fail the same person rule as every other account.

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

/// Unbound operations accounts cannot approve or request a governed unlock.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unbound_operations_accounts_cannot_be_either_decision_party(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let mut requester = admin(&owner, &svc, &issuer, "요청자").await;
    let mut absent = admin(&owner, &svc, &issuer, "부재자").await;
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
        refused["error"]["code"], "period_unlock.refuse.identity_unbound",
        "{refused}"
    );
    // No side effect from either refusal.
    assert!(active(&owner, lock_id).await);
    assert!(unlocks(&owner, lock_id).await.is_empty());

    // Operations privileges and step-up do not substitute for a Person binding.
    sqlx::query("UPDATE authz_grant_ledger SET occurred_at=now() WHERE user_id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    // Missing identity refuses before a step-up ceremony is requested.
    let (status, refused) =
        approve(&service, &owner, &svc, &mut ops, lock_id, request_id, false).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"], "period_unlock.refuse.identity_unbound",
        "{refused}"
    );

    let (status, refused) =
        approve(&service, &owner, &svc, &mut ops, lock_id, request_id, true).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "period_unlock.refuse.identity_unbound"
    );
    assert!(active(&owner, lock_id).await);
    assert!(unlocks(&owner, lock_id).await.is_empty());
    // A legacy request whose maker loses its person binding is refused too.
    let mut identity = owner.begin().await.unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=false,person_id=(SELECT person_id FROM users WHERE id=$2) WHERE id=$1")
        .bind(ops.id).bind(absent.id).execute(identity.as_mut()).await.unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(requester.id)
        .execute(identity.as_mut())
        .await
        .unwrap();
    identity.commit().await.unwrap();
    let (status, refused) = approve(
        &service,
        &owner,
        &svc,
        &mut absent,
        lock_id,
        request_id,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "period_unlock.refuse.identity_unbound"
    );
    assert!(active(&owner, lock_id).await);
    assert!(unlocks(&owner, lock_id).await.is_empty());
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(1))
        .format(&Rfc3339)
        .unwrap();
    let (status, refused) = send(
        &service,
        &format!("{LOCKS}/{lock_id}/unlock"),
        &requester.token,
        None,
        json!({"reasonCode":"PAYROLL_ERROR","relockAt":relock_at}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "period_unlock.refuse.identity_unbound"
    );
}

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-15 through the router with real (software) passkeys: a requester's
//! step-up unlock waits for the eligible second person, the requester cannot
//! approve it, and the second person's step-up performs it; a sole holder
//! unlocks at once, flagged for review. Idempotency-Key replays lock and unlock.

mod period_unlock_support;

use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{LOCKS, admin, router, send, step_up};
use serde_json::json;
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sole_holder_unlocks_at_once_and_is_flagged_for_review(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Solo setup')")
        .bind(org)
        .bind(org.to_string())
        .execute(&owner)
        .await
        .unwrap();
    let mut only = period_unlock_support::admin_in(
        &owner,
        &svc,
        &issuer,
        console_kernel_core::OrgId::from_uuid(org),
        "단독",
    )
    .await;
    let lock = json!({"domain": "accounting", "periodStart": "2026-06-01",
                      "periodEnd": "2026-06-30", "reasonCode": "BOOKS_CLOSE"});
    let (status, locked) = send(&service, LOCKS, &only.token, None, lock).await;
    assert_eq!(status, StatusCode::CREATED, "{locked}");
    let lock_id: Uuid = locked["id"].as_str().unwrap().parse().unwrap();
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(1))
        .format(&Rfc3339)
        .unwrap();
    let payload = format!("PERIOD_UNLOCK\n{lock_id}\nAUDIT_FINDING\n{relock_at}");
    let body = json!({"reasonCode": "AUDIT_FINDING", "relockAt": relock_at,
                      "stepUp": step_up(&owner, &svc, &mut only, lock_id, &payload).await});
    let (status, unlocked) = send(
        &service,
        &format!("{LOCKS}/{lock_id}/unlock"),
        &only.token,
        None,
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unlocked}");
    assert_eq!(unlocked["status"], "UNLOCKED");
    assert_eq!(unlocked["lock"]["unlockReviewRequired"], true);
    assert_eq!(unlocked["lock"]["active"], false);
    // Names, not bare ids, for the screen (BW-15).
    assert_eq!(locked["lockedByName"], "단독", "{locked}");
    assert_eq!(unlocked["lock"]["unlockedByName"], "단독", "{unlocked}");
    // Decisions #7 case B: the 예외 처리 mark and its 사후 검토 item, consumed by this unlock.
    let exception_id: Uuid = unlocked["exception"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        unlocked["exception"]["reviewDueAt"].is_string(),
        "{unlocked}"
    );
    let unlocked_id: Uuid = unlocked["lock"]["id"].as_str().unwrap().parse().unwrap();
    let row: (String, String, String, Uuid, Uuid, bool, bool, bool) = sqlx::query_as(
        "SELECT rule_code, status, subject_type, subject_id, requested_by, \
                fallback_kind = 'SOLE_HOLDER', review_due_at > now(), consumed_at IS NOT NULL \
         FROM governed_exceptions WHERE id = $1",
    )
    .bind(exception_id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "PERIOD_UNLOCK_SOLE_HOLDER".to_owned(),
            "RECORDED".to_owned(),
            "PERIOD_LOCK".to_owned(),
            unlocked_id,
            only.id,
            true,
            true,
            true
        )
    );
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('a',64) WHERE org_id=$1")
        .bind(org).bind(only.id).execute(&owner).await.unwrap();
    let (_,locked)=send(&service,LOCKS,&only.token,None,json!({"domain":"accounting","periodStart":"2026-07-01","periodEnd":"2026-07-31","reasonCode":"BOOKS_CLOSE"})).await;
    let id: Uuid = locked["id"].as_str().unwrap().parse().unwrap();
    let payload = format!("PERIOD_UNLOCK\n{id}\nAUDIT_FINDING\n{relock_at}");
    let assertion = step_up(&owner, &svc, &mut only, id, &payload).await;
    let (status, refused) = send(
        &service,
        &format!("{LOCKS}/{id}/unlock"),
        &only.token,
        None,
        json!({"reasonCode":"AUDIT_FINDING","relockAt":relock_at,"stepUp":assertion}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "period_unlock_sole_holder_refused"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM governed_exceptions WHERE org_id=$1")
            .bind(org)
            .fetch_one(&owner)
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_person_performs_the_unlock_with_their_own_step_up(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let mut requester = admin(&owner, &svc, &issuer, "요청자").await;
    let mut approver = admin(&owner, &svc, &issuer, "승인자").await;

    // Lock June; a replay with the same key returns the same lock.
    let lock = json!({"domain": "payroll", "periodStart": "2026-06-01",
                      "periodEnd": "2026-06-30", "reasonCode": "MONTHLY_PAYROLL_CLOSE"});
    let (status, locked) = send(
        &service,
        LOCKS,
        &requester.token,
        Some("bw15-lock-key-0001"),
        lock.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{locked}");
    let (status, replay) = send(
        &service,
        LOCKS,
        &requester.token,
        Some("bw15-lock-key-0001"),
        lock,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], locked["id"]);
    let lock_id: Uuid = locked["id"].as_str().unwrap().parse().unwrap();

    // The requester's step-up opens a request: another eligible holder exists.
    let relock_at = (OffsetDateTime::now_utc() + Duration::days(3))
        .format(&Rfc3339)
        .unwrap();
    let payload = format!("PERIOD_UNLOCK\n{lock_id}\nPAYROLL_ERROR\n{relock_at}");
    let unlock_uri = format!("{LOCKS}/{lock_id}/unlock");
    let body = json!({"reasonCode": "PAYROLL_ERROR", "relockAt": relock_at,
                      "stepUp": step_up(&owner, &svc, &mut requester, lock_id, &payload).await});
    let (status, pending) = send(
        &service,
        &unlock_uri,
        &requester.token,
        Some("bw15-unlock-key-01"),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
    assert_eq!(pending["status"], "PENDING_SECOND_PERSON");
    assert_eq!(pending["lock"]["active"], true);
    // A replay does not spend another step-up and returns the stored answer.
    let (status, again) = send(
        &service,
        &unlock_uri,
        &requester.token,
        Some("bw15-unlock-key-01"),
        body,
    )
    .await;
    assert_eq!((status, &again), (StatusCode::OK, &pending));
    let request_id: Uuid = pending["request"]["id"].as_str().unwrap().parse().unwrap();

    // The requester is never their own second person.
    let approve_uri = format!("{unlock_uri}/approve");
    let own = step_up(
        &owner,
        &svc,
        &mut requester,
        request_id,
        &format!("PERIOD_UNLOCK_APPROVE\n{request_id}"),
    )
    .await;
    let (status, refused) = send(
        &service,
        &approve_uri,
        &requester.token,
        None,
        json!({"stepUp": own}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"], "second_person_required",
        "{refused}"
    );

    // The second person's own step-up performs it.
    let theirs = step_up(
        &owner,
        &svc,
        &mut approver,
        request_id,
        &format!("PERIOD_UNLOCK_APPROVE\n{request_id}"),
    )
    .await;
    let (status, unlocked) = send(
        &service,
        &approve_uri,
        &approver.token,
        None,
        json!({"stepUp": theirs}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unlocked}");
    assert_eq!(unlocked["status"], "UNLOCKED");
    assert_eq!(unlocked["lock"]["active"], false);
    assert_eq!(unlocked["lock"]["unlockedBy"], requester.id.to_string());
    assert_eq!(
        unlocked["lock"]["unlockApprovedBy"],
        approver.id.to_string()
    );
    assert_eq!(unlocked["lock"]["unlockApprovedByName"], "승인자");
    assert_eq!(unlocked["lock"]["unlockReviewRequired"], false);
    // A second-person unlock is no 예외 처리: no exception is recorded.
    assert!(unlocked.get("exception").is_none(), "{unlocked}");
    assert_eq!(
        unlocked["lock"]["relockAt"].as_str().map(|s| s.is_empty()),
        Some(false)
    );
}

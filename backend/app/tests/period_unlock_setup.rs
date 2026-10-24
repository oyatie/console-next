// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Solo unlock depends on eligible people and ends at go-live.

mod period_unlock_support;

use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{LOCKS, admin_in, router, send, step_up};
use serde_json::json;
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_with_ops_and_one_linked_admin_unlocks_via_solo_review(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let org = setup_tenant(&owner).await;
    let ops = admin_in(&owner, &svc, &issuer, org, "운영 계정").await;
    sqlx::query("UPDATE users SET employee_id=NULL,is_tenant_ops=true WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    let mut human = admin_in(&owner, &svc, &issuer, org, "단독 관리자").await;
    let (id, relock_at) = lock(&service, &human.token).await;
    let payload = format!("PERIOD_UNLOCK\n{id}\nAUDIT_FINDING\n{relock_at}");
    let assertion = step_up(&owner, &svc, &mut human, id, &payload).await;
    let (status, unlocked) = send(
        &service,
        &format!("{LOCKS}/{id}/unlock"),
        &human.token,
        None,
        json!({"reasonCode":"AUDIT_FINDING","relockAt":relock_at,
            "stepUp":assertion}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unlocked}");
    assert_eq!(unlocked["status"], "UNLOCKED");
    assert_eq!(unlocked["lock"]["active"], false);
    assert_eq!(unlocked["lock"]["unlockReviewRequired"], true);
    let exception: (Uuid, Uuid, String) = sqlx::query_as(
        "SELECT requested_by,subject_id,status FROM governed_exceptions WHERE id=$1",
    )
    .bind(
        unlocked["exception"]["id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap(),
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(exception, (human.id, id, "RECORDED".to_owned()));
    // The linked human prevents unbound ops from taking the setup solo exception.
    let (status, refused) = send(
        &service,
        &format!("{LOCKS}/{id}/unlock"),
        &ops.token,
        None,
        json!({"reasonCode":"AUDIT_FINDING","relockAt":relock_at}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "period_unlock.refuse.identity_unbound"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operating_bound_sole_holder_is_refused_without_side_effects(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let org = setup_tenant(&owner).await;
    let mut human = admin_in(&owner, &svc, &issuer, org, "단독 관리자").await;
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('a',64) WHERE org_id=$1")
        .bind(org.as_uuid()).bind(human.id).execute(&owner).await.unwrap();
    let (id, relock_at) = lock(&service, &human.token).await;
    let payload = format!("PERIOD_UNLOCK\n{id}\nAUDIT_FINDING\n{relock_at}");
    let assertion = step_up(&owner, &svc, &mut human, id, &payload).await;
    let (status, refused) = send(
        &service,
        &format!("{LOCKS}/{id}/unlock"),
        &human.token,
        None,
        json!({"reasonCode":"AUDIT_FINDING","relockAt":relock_at,
            "stepUp":assertion}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "period_unlock_sole_holder_refused"
    );
    let unchanged: (bool, i64, i64) = sqlx::query_as(
        "SELECT period_lock_effective(l), \
         (SELECT count(*) FROM governed_exceptions WHERE org_id=l.org_id), \
         (SELECT count(*) FROM audit_events WHERE target_id=l.id::text AND action='period_lock.unlock') \
         FROM period_locks l WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(unchanged, (true, 0, 0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_counts_only_reviewed_employee_bound_second_people(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    for state in ["BOUND", "UNBOUND", "ACCOUNT_REVIEW", "EMPLOYEE_REVIEW"] {
        let org = setup_tenant(&owner).await;
        let mut human = admin_in(&owner, &svc, &issuer, org, "요청자").await;
        let other = admin_in(&owner, &svc, &issuer, org, "다른 관리자").await;
        match state {
            "UNBOUND" => {
                sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=(SELECT employee_id FROM users WHERE id=$1)")
                    .bind(other.id).execute(&owner).await.unwrap();
            }
            "ACCOUNT_REVIEW" | "EMPLOYEE_REVIEW" => {
                sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) SELECT org_id,CASE WHEN $2 THEN 'EMPLOYEE' ELSE 'ACCOUNT' END,CASE WHEN $2 THEN employee_id ELSE id END,'NUMBER_BIRTH_AMBIGUOUS','{}' FROM users WHERE id=$1 ON CONFLICT (org_id,subject_kind,subject_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=clock_timestamp()")
                    .bind(other.id).bind(state == "EMPLOYEE_REVIEW").execute(&owner).await.unwrap();
                assert_eq!(
                    sqlx::query_scalar::<_, i64>(
                        "SELECT count(*) FROM person_binding_reviews_open WHERE org_id=$1"
                    )
                    .bind(org.as_uuid())
                    .fetch_one(&owner)
                    .await
                    .unwrap(),
                    1,
                );
            }
            _ => {}
        }
        let (id, relock_at) = lock(&service, &human.token).await;
        let payload = format!("PERIOD_UNLOCK\n{id}\nAUDIT_FINDING\n{relock_at}");
        let assertion = step_up(&owner, &svc, &mut human, id, &payload).await;
        let (status, outcome) = send(
            &service,
            &format!("{LOCKS}/{id}/unlock"),
            &human.token,
            None,
            json!({"reasonCode":"AUDIT_FINDING","relockAt":relock_at,
                "stepUp":assertion}),
        )
        .await;
        if state == "BOUND" {
            assert_eq!(status, StatusCode::ACCEPTED, "{state}: {outcome}");
            assert_eq!(outcome["status"], "PENDING_SECOND_PERSON");
            assert_eq!(outcome["lock"]["active"], true);
            assert!(outcome.get("exception").is_none());
        } else {
            assert_eq!(status, StatusCode::OK, "{state}: {outcome}");
            assert_eq!(outcome["status"], "UNLOCKED");
            assert_eq!(outcome["lock"]["unlockReviewRequired"], true);
        }
    }
}

async fn setup_tenant(owner: &PgPool) -> OrgId {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Unlock setup')")
        .bind(org)
        .bind(org.to_string())
        .execute(owner)
        .await
        .unwrap();
    OrgId::from_uuid(org)
}

async fn lock(service: &axum::Router, token: &str) -> (Uuid, String) {
    let (status, locked) = send(
        service,
        LOCKS,
        token,
        None,
        json!({"domain":"accounting","periodStart":"2026-06-01",
            "periodEnd":"2026-06-30","reasonCode":"BOOKS_CLOSE"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{locked}");
    (
        locked["id"].as_str().unwrap().parse().unwrap(),
        (OffsetDateTime::now_utc() + Duration::days(1))
            .format(&Rfc3339)
            .unwrap(),
    )
}

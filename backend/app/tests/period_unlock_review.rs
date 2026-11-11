// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Post-unlock work uses live entitlement and a separate receipt for each exception.
mod period_unlock_support;
use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{LOCKS, admin_in, read, router, send, session_token, step_up};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const INBOX: &str = "/api/v1/me/action-inbox";

async fn unlock(
    owner: &PgPool,
    app: &axum::Router,
    human: &mut period_unlock_support::Admin,
) -> Value {
    let (status, lock) = send(app, LOCKS, &human.token, None, json!({"domain":"accounting","periodStart":"2026-06-01","periodEnd":"2026-06-30","reasonCode":"BOOKS_CLOSE"})).await;
    assert_eq!(status, StatusCode::CREATED, "{lock}");
    let id = lock["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let until = (OffsetDateTime::now_utc() + Duration::days(1))
        .format(&Rfc3339)
        .unwrap();
    let assertion = step_up(
        owner,
        &passkey_service(),
        human,
        id,
        &format!("PERIOD_UNLOCK\n{id}\nAUDIT_FINDING\n{until}"),
    )
    .await;
    let (status, result) = send(
        app,
        &format!("{LOCKS}/{id}/unlock"),
        &human.token,
        None,
        json!({"reasonCode":"AUDIT_FINDING","relockAt":until,"stepUp":assertion}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    result
}

fn review_path(unlocked: &Value) -> String {
    format!(
        "{LOCKS}/{}/unlock/reviews/{}/acknowledge",
        unlocked["lock"]["id"].as_str().unwrap(),
        unlocked["exception"]["id"].as_str().unwrap()
    )
}

async fn reviews(app: &axum::Router, token: &str) -> Vec<Value> {
    let (status, inbox) = read(app, INBOX, token).await;
    assert_eq!(status, StatusCode::OK, "{inbox}");
    assert!(
        inbox["incomplete_sources"]
            .as_array()
            .is_none_or(|sources| !sources.iter().any(|s| s == "period_unlock")),
        "{inbox}"
    );
    inbox["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["context"]["unlock"]["exceptionId"].is_string())
        .cloned()
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operating_review_is_owned_acknowledged_and_repeat_unlock_is_a_new_item(owner: PgPool) {
    let (app, issuer) = router(&owner).await;
    let svc = passkey_service();
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Review tenant')")
        .bind(org)
        .bind(org.to_string())
        .execute(&owner)
        .await
        .unwrap();
    let org = OrgId::from_uuid(org);
    let mut human = admin_in(&owner, &svc, &issuer, org, "단독 관리자").await;
    let ops = admin_in(&owner, &svc, &issuer, org, "운영 계정").await;
    sqlx::query("UPDATE users SET employee_id=NULL,is_tenant_ops=true WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('a',64) WHERE org_id=$1").bind(org.as_uuid()).bind(human.id).execute(&owner).await.unwrap();
    let first = unlock(&owner, &app, &mut human).await;
    let second = unlock(&owner, &app, &mut human).await;
    let items = reviews(&app, &ops.token).await;
    assert_eq!(items.len(), 2, "each exception must survive independently");
    for unlocked in [&first, &second] {
        let item = items
            .iter()
            .find(|item| {
                item["id"]
                    == format!(
                        "period_unlock:{}",
                        unlocked["exception"]["id"].as_str().unwrap()
                    )
            })
            .unwrap();
        assert_eq!(item["due"], unlocked["exception"]["reviewDueAt"]);
        assert_eq!(item["links"][0]["kind"], "period_lock");
        assert_eq!(item["links"][0]["id"], unlocked["lock"]["id"]);
    }
    assert!(reviews(&app, &human.token).await.is_empty());
    let (status, body) = send(&app, &review_path(&first), &human.token, None, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
    // A valid session without a close grant may neither see nor close the work.
    let nobody = admin_in(&owner, &svc, &issuer, org, "권한 없음").await;
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE id=$1")
        .bind(nobody.id)
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("DELETE FROM access_grants WHERE account_id=$1")
        .bind(nobody.id)
        .execute(&owner)
        .await
        .unwrap();
    let token = session_token(&owner, &issuer, org, nobody.id, "MEMBER").await;
    assert!(reviews(&app, &token).await.is_empty());
    let (status, body) = send(&app, &review_path(&first), &token, None, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
    for _ in 0..2 {
        let (status, body) = send(&app, &review_path(&first), &ops.token, None, json!({})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    assert_eq!(reviews(&app, &ops.token).await.len(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_id=$2 AND action='exception.review'").bind(org.as_uuid()).bind(first["exception"]["id"].as_str().unwrap()).fetch_one(&owner).await.unwrap();
    assert_eq!(count, 1, "acknowledgement is idempotent");
    let (status, body) = send(&app, &review_path(&second), &ops.token, None, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(reviews(&app, &ops.token).await.is_empty());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE org_id=$1 AND category='period_lock.sole_holder'",
    )
    .bind(org.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(count, 0, "the work inbox is the only delivery surface");
    // With no other current reviewer, the solo holder can acknowledge their work.
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    let third = unlock(&owner, &app, &mut human).await;
    assert_eq!(reviews(&app, &human.token).await.len(), 1);
    let (status, body) = send(&app, &review_path(&third), &human.token, None, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(reviews(&app, &human.token).await.is_empty());
}

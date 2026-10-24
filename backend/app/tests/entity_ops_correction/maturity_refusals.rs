// SPDX-License-Identifier: LicenseRef-Proprietary
use super::maturity::{get, request};
use super::*;

const REGISTER: &str = "/api/v1/entity-identifier-corrections";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicate_pending_is_refused(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (status, first, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{first}");
    let (status, duplicate, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::CONFLICT, "{duplicate}");
    assert_eq!(duplicate["error"]["code"], "identifier_correction_pending");
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM governed_exceptions WHERE subject_id=$1",
            s.entity
        )
        .await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn post_review_of_pending_is_refused(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (_, first, _) = request(&owner, &mut s).await;
    let id = first["exception_id"].as_str().unwrap();
    let (status, refused) = send(
        &s.service,
        &format!("{REGISTER}/{id}/review"),
        &s.approver.token,
        Some(&key()),
        json!({"note":"검토"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_not_recorded");
    let (status, refused) = send(
        &s.service,
        &format!("{REGISTER}/{id}/review"),
        &s.approver.token,
        Some(&key()),
        json!({"note":" "}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert_eq!(refused["error"]["code"], "validation_failed");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_register_and_decisions_require_auth_and_isolate_tenants(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let id = receipt["exception_id"].as_str().unwrap();
    assert_eq!(get(&s, REGISTER, "").await.0, StatusCode::UNAUTHORIZED);
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        "",
        Some(&key()),
        json!({"decision":"DECLINE","reason_code":"DOCUMENT_MISMATCH"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'다른 조직')")
        .bind(org)
        .bind(format!("other-{}", org.simple()))
        .execute(&owner)
        .await
        .unwrap();
    let outsider = admin_in(
        &owner,
        &s.svc,
        &s.issuer,
        OrgId::from_uuid(org),
        "다른 조직 관리자",
    )
    .await;
    let (status, body) = get(&s, &format!("{REGISTER}/{id}"), &outsider.token).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "exception_not_found");
    let (status, body) = get(&s, REGISTER, &outsider.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], json!([]));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn expired_request_projects_expired_and_cannot_be_decided(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let source: Uuid = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM governed_exceptions WHERE id=$1")
        .bind(source)
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let id: Uuid = sqlx::query_scalar("INSERT INTO governed_exceptions (org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,expires_at,created_at) SELECT org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,now()-interval '1 day',now()-interval '30 days' FROM governed_exceptions WHERE id=$1 RETURNING id")
        .bind(source).fetch_one(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let (status, body) = get(&s, &format!("{REGISTER}/{id}"), &s.approver.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"][0]["status"], "EXPIRED");
    assert_eq!(body["items"][0]["can_decide"], false);
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"DECLINE","reason_code":"DOCUMENT_MISMATCH"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "exception_expired");
}

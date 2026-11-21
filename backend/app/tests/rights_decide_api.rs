// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod period_unlock_support;
mod rights_decide_support;
mod settings_support;

use console_compliance_adapter_postgres::rights::{self, DecideInput};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::MobileStepUpActionKind;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{person_fixtures, read, router, send, step_up_as};
use rights_decide_support::{decide_with_step_up, grant_privacy_intake, postpone_with_step_up};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_decide_postpone_and_sod_lifecycle(pool: PgPool) {
    let org = OrgId::new();
    let other_org = OrgId::new();
    for tenant in [org, other_org] {
        sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Privacy org')")
            .bind(tenant.as_uuid())
            .bind(tenant.to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (service, issuer) = router(&pool).await;
    let svc = passkey_service();
    let mut requester =
        period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Requester").await;
    let mut handler_a =
        period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Handler A").await;
    let mut req_alias = period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Alias").await;
    let mut foreign =
        period_unlock_support::admin_in(&pool, &svc, &issuer, other_org, "Foreign").await;
    let req_uid = UserId::from_uuid(requester.id);
    grant_privacy_intake(&pool, org, UserId::from_uuid(handler_a.id), requester.id).await;
    for id in [handler_a.id, req_alias.id] {
        grant_privacy_intake(&pool, org, req_uid, id).await;
    }
    let foreign_grantor =
        settings_support::seed_user(&pool, *other_org.as_uuid(), "SUPER_ADMIN").await;
    grant_privacy_intake(&pool, other_org, foreign_grantor, foreign.id).await;

    let requester_person: Uuid = sqlx::query_scalar(
        "SELECT b.person_id FROM users u JOIN employee_person_bindings b ON b.org_id=u.org_id AND b.employee_id=u.employee_id WHERE u.id=$1",
    )
    .bind(requester.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=(SELECT employee_id FROM users WHERE id=$1)")
        .bind(req_alias.id)
        .execute(&pool)
        .await
        .unwrap();
    person_fixtures::bind_user_to_person(&pool, UserId::from_uuid(req_alias.id), requester_person)
        .await;

    let filing = json!({"controller":"TENANT","kinds":["ACCESS","CORRECTION","DELETION"],"detail":"Review request"});
    let f_parsed: rights::Filing = serde_json::from_value(filing.clone()).unwrap();
    let f_hash = serde_json::to_string(&f_parsed).unwrap();
    let req_actor_id = requester.id;
    let f_step_up = step_up_as(
        &pool,
        &svc,
        &mut requester,
        MobileStepUpActionKind::PrivacyRequest,
        req_actor_id,
        &f_hash,
    )
    .await;
    let mut f_body = filing;
    f_body["step_up"] = f_step_up;
    let (st, filed) = send(
        &service,
        "/api/v1/privacy/rights-requests",
        &requester.token,
        Some(&Uuid::new_v4().to_string()),
        f_body,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{filed}");
    let req_id = Uuid::parse_str(filed["id"].as_str().unwrap()).unwrap();

    let (st, listed) = read(
        &service,
        "/api/v1/privacy/rights-requests?status=RECEIVED",
        &handler_a.token,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{listed}");
    assert_eq!(listed["items"][0]["request"]["id"], filed["id"]);

    let (st, missing_step) = send(
        &service,
        &format!("/api/v1/privacy/rights-requests/{req_id}/decide"),
        &handler_a.token,
        Some(&Uuid::new_v4().to_string()),
        json!({"kind":"CORRECTION","outcome":"GRANTED"}),
    )
    .await;
    assert_eq!(
        (st, missing_step["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("passkey_step_up_required"))
    );

    let wrong_input = json!({"kind":"CORRECTION","outcome":"GRANTED"});
    let wrong_parsed: DecideInput = serde_json::from_value(wrong_input).unwrap();
    let wrong_step = step_up_as(
        &pool,
        &svc,
        &mut handler_a,
        MobileStepUpActionKind::PrivacyRequestDecide,
        Uuid::new_v4(),
        &serde_json::to_string(&wrong_parsed).unwrap(),
    )
    .await;
    let (st, mismatched) = send(
        &service,
        &format!("/api/v1/privacy/rights-requests/{req_id}/decide"),
        &handler_a.token,
        Some(&Uuid::new_v4().to_string()),
        json!({"kind":"CORRECTION","outcome":"GRANTED","step_up":wrong_step}),
    )
    .await;
    assert_eq!(
        (st, mismatched["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("passkey_step_up_failed"))
    );

    let grant_body = json!({"kind":"CORRECTION","outcome":"GRANTED"});
    for bad_actor in [&mut requester, &mut req_alias] {
        let (st, refused) =
            decide_with_step_up(&pool, &svc, &service, bad_actor, req_id, grant_body.clone()).await;
        assert_eq!(
            (st, refused["error"]["code"].as_str()),
            (StatusCode::FORBIDDEN, Some("own_request_forbidden"))
        );
    }

    let (st, xtenant) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut foreign,
        req_id,
        grant_body.clone(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{xtenant}");

    let (st, postponed) = postpone_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_a,
        req_id,
        json!({"kind":"ACCESS","reason":"JUSTIFIED_REASON","note":"Needs verification"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{postponed}");
    assert_eq!(postponed["status"], "RECEIVED");

    let (st, granted) =
        decide_with_step_up(&pool, &svc, &service, &mut handler_a, req_id, grant_body).await;
    assert_eq!(st, StatusCode::OK, "{granted}");
    let (st, partial) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_a,
        req_id,
        json!({"kind":"DELETION","outcome":"PARTIAL","reason":"REQUIRED_BY_LAW","note":"Retained per tax statute"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{partial}");
    let (st, refused_access) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_a,
        req_id,
        json!({"kind":"ACCESS","outcome":"REFUSED","reason":"HARM_TO_OTHERS","note":"Affects third party"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{refused_access}");
    assert_eq!(refused_access["status"], "DECIDED");

    let db_err = sqlx::query("UPDATE privacy_rights_requests SET body=jsonb_set(body,'{status}','\"RECEIVED\"') WHERE id=$1")
        .bind(req_id)
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(
        db_err.to_string().contains("terminal after DECIDED"),
        "{db_err}"
    );
}

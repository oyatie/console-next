// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod period_unlock_support;
mod rights_decide_support;
mod settings_support;

use console_compliance_adapter_postgres::rights;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::MobileStepUpActionKind;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{router, send, step_up_as};
use rights_decide_support::{decide_with_step_up, grant_privacy_intake};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_objection_off_app_intake_and_identity_unbound_sod(pool: PgPool) {
    let org = OrgId::new();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Privacy org')")
        .bind(org.as_uuid())
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (service, issuer) = router(&pool).await;
    let svc = passkey_service();
    let mut requester =
        period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Requester").await;
    let mut handler_a =
        period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Handler A").await;
    let mut handler_b =
        period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Handler B").await;
    let req_uid = UserId::from_uuid(requester.id);
    grant_privacy_intake(&pool, org, UserId::from_uuid(handler_a.id), requester.id).await;
    for id in [handler_a.id, handler_b.id] {
        grant_privacy_intake(&pool, org, req_uid, id).await;
    }

    let filing = json!({"controller":"TENANT","kinds":["ACCESS"],"detail":"Objection test"});
    let f_parsed: rights::Filing = serde_json::from_value(filing.clone()).unwrap();
    let req_actor_id = requester.id;
    let f_step_up = step_up_as(
        &pool,
        &svc,
        &mut requester,
        MobileStepUpActionKind::PrivacyRequest,
        req_actor_id,
        &serde_json::to_string(&f_parsed).unwrap(),
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

    let (st, refused) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_a,
        req_id,
        json!({"kind":"ACCESS","outcome":"REFUSED","reason":"HARM_TO_OTHERS","note":"Refused"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{refused}");

    let (st, obj) = send(
        &service,
        &format!("/api/v1/privacy/rights-requests/{req_id}/objection"),
        &requester.token,
        Some(&Uuid::new_v4().to_string()),
        json!({"kinds":["ACCESS"],"detail":"Disagree with refusal"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{obj}");
    let obj_id = Uuid::parse_str(obj["id"].as_str().unwrap()).unwrap();
    assert_eq!(obj["objection_of"], filed["id"]);

    let (st, same_decider) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_a,
        obj_id,
        json!({"kind":"ACCESS","outcome":"GRANTED"}),
    )
    .await;
    assert_eq!(
        (st, same_decider["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("objection_same_decider"))
    );

    let (st, obj_granted) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_b,
        obj_id,
        json!({"kind":"ACCESS","outcome":"GRANTED"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{obj_granted}");
    assert_eq!(obj_granted["status"], "DECIDED");

    let today = console_hr_adapter_postgres::clock::today_kst().to_string();
    let (st, off_app) = send(
        &service,
        "/api/v1/privacy/rights-requests/received",
        &handler_a.token,
        Some(&Uuid::new_v4().to_string()),
        json!({
            "subject_user_id": requester.id,
            "controller": "TENANT",
            "channel": "PHONE",
            "agent": "SUBJECT",
            "mandate_received": false,
            "identity_method": "KNOWN_CONTACT",
            "received_on": today,
            "kinds": ["ACCESS"],
            "detail": "Phone request"
        }),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{off_app}");
    let off_id = Uuid::parse_str(off_app["id"].as_str().unwrap()).unwrap();

    let (st, filer_blocked) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_a,
        off_id,
        json!({"kind":"ACCESS","outcome":"GRANTED"}),
    )
    .await;
    assert_eq!(
        (st, filer_blocked["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("own_request_forbidden"))
    );

    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=(SELECT employee_id FROM users WHERE id=$1)")
        .bind(handler_b.id)
        .execute(&pool)
        .await
        .unwrap();
    let (st, unbound) = decide_with_step_up(
        &pool,
        &svc,
        &service,
        &mut handler_b,
        off_id,
        json!({"kind":"ACCESS","outcome":"GRANTED"}),
    )
    .await;
    assert_eq!(
        (st, unbound["error"]["code"].as_str()),
        (
            StatusCode::FORBIDDEN,
            Some("privacy.refuse.identity_unbound")
        )
    );

    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE org_id=$1 AND action LIKE 'privacy_request.%' ORDER BY occurred_at",
    )
    .bind(org.as_uuid())
    .fetch_all(&pool)
    .await
    .unwrap();
    for expected in [
        "privacy_request.received",
        "privacy_request.decided",
        "privacy_request.objection_received",
    ] {
        assert!(
            actions.contains(&expected.to_owned()),
            "missing {expected} in {actions:?}"
        );
    }
}

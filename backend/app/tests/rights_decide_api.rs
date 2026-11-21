// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod period_unlock_support;
mod settings_support;

use console_compliance_adapter_postgres::rights::{self, DecideInput, PostponeInput};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::MobileStepUpActionKind;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use period_unlock_support::{Admin, person_fixtures, read, router, send, step_up_as};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn grant_privacy_intake(pool: &PgPool, org: OrgId, grantor: UserId, handler: Uuid) {
    let grant = settings_support::seed_role_and_grant(
        pool,
        *org.as_uuid(),
        grantor,
        UserId::from_uuid(handler),
        "TENANT",
        None,
    )
    .await;
    for sql in [
        "INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id=(SELECT role_id FROM access_grants WHERE id=$2)",
        "INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE id=$2",
        "UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=(SELECT role_id FROM access_grants WHERE id=$2)",
    ] {
        sqlx::query(sql)
            .bind(org.as_uuid())
            .bind(grant)
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn decide_with_step_up(
    pool: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    service: &axum::Router,
    actor: &mut Admin,
    req_id: Uuid,
    input: Value,
) -> (StatusCode, Value) {
    let parsed: DecideInput = serde_json::from_value(input.clone()).unwrap();
    let payload = serde_json::to_string(&parsed).unwrap();
    let step_up = step_up_as(
        pool,
        svc,
        actor,
        MobileStepUpActionKind::PrivacyRequestDecide,
        req_id,
        &payload,
    )
    .await;
    let mut body = input;
    body["step_up"] = step_up;
    let uri = format!("/api/v1/privacy/rights-requests/{req_id}/decide");
    let key = Uuid::new_v4().to_string();
    send(service, &uri, &actor.token, Some(&key), body).await
}

async fn postpone_with_step_up(
    pool: &PgPool,
    svc: &console_platform_auth::PasskeyService,
    service: &axum::Router,
    actor: &mut Admin,
    req_id: Uuid,
    input: Value,
) -> (StatusCode, Value) {
    let parsed: PostponeInput = serde_json::from_value(input.clone()).unwrap();
    let payload = serde_json::to_string(&parsed).unwrap();
    let step_up = step_up_as(
        pool,
        svc,
        actor,
        MobileStepUpActionKind::PrivacyRequestDecide,
        req_id,
        &payload,
    )
    .await;
    let mut body = input;
    body["step_up"] = step_up;
    let uri = format!("/api/v1/privacy/rights-requests/{req_id}/postpone");
    let key = Uuid::new_v4().to_string();
    send(service, &uri, &actor.token, Some(&key), body).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_decide_postpone_objection_and_sod_lifecycle(pool: PgPool) {
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
    let mut handler_b =
        period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Handler B").await;
    let mut req_alias = period_unlock_support::admin_in(&pool, &svc, &issuer, org, "Alias").await;
    let mut foreign =
        period_unlock_support::admin_in(&pool, &svc, &issuer, other_org, "Foreign").await;
    let req_uid = UserId::from_uuid(requester.id);
    grant_privacy_intake(&pool, org, UserId::from_uuid(handler_a.id), requester.id).await;
    for id in [handler_a.id, handler_b.id, req_alias.id] {
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
        "privacy_request.intake_listed",
        "privacy_request.postponed",
        "privacy_request.decided",
        "privacy_request.objection_received",
    ] {
        assert!(
            actions.contains(&expected.to_owned()),
            "missing {expected} in {actions:?}"
        );
    }
}

// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_app::build_router;
use http::StatusCode;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rights_requests_are_self_only_and_filing_requires_step_up(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Privacy test')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let user = seed_user(&pool, org, "MEMBER").await;
    let keys = keys();
    let bearer = token(&pool, &keys, org, user, "MEMBER").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1).unwrap());
    let uri = "/api/v1/privacy/rights-requests";
    let mine = format!("{uri}/mine");
    let (status, _) = send(&service, "GET", &mine, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, page) = send(&service, "GET", &mine, Some(&bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"], json!([]));
    assert!(page["next_cursor"].is_null());
    assert!(page["as_of"].as_str().is_some());
    let (status, refusal) = send(
        &service,
        "POST",
        uri,
        Some(&bearer),
        Some(json!({
            "controller":"OPERATOR","kinds":["ACCESS"],"detail":"Account records"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refusal}");
    assert_eq!(refusal["error"]["code"], "passkey_step_up_required");
    let (status, refusal) = send(
        &service,
        "GET",
        &format!("{mine}?cursor=invalid"),
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refusal}");
    assert_eq!(refusal["error"]["code"], "cursor_invalid");
}

mod period_unlock_support;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rights_filing_passkey_binding_replay_and_refusals(pool: PgPool) {
    use console_kernel_core::OrgId;
    use console_platform_auth::MobileStepUpActionKind;
    use console_platform_test_support::soft_passkey::passkey_service;
    use period_unlock_support::{admin_in, router, step_up_as};
    let org = OrgId::new();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Privacy test')")
        .bind(org.as_uuid())
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (service, issuer) = router(&pool).await;
    let svc = passkey_service();
    let mut actor = admin_in(&pool, &svc, &issuer, org, "Subject").await;
    let uri = "/api/v1/privacy/rights-requests";
    for (input, expected) in [
        (
            json!({"controller":"OPERATOR","kinds":["ACCESS"],"detail":"My account"}),
            None,
        ),
        (
            json!({"controller":"OPERATOR","kinds":[],"detail":""}),
            Some("request_kind_required"),
        ),
        (
            json!({"controller":"OPERATOR","kinds":["AUTOMATED_DECISION"],"detail":""}),
            Some("request_kind_unavailable"),
        ),
        (
            json!({"controller":"OPERATOR","kinds":["ACCESS"],"detail":"a".repeat(2001)}),
            Some("detail_too_long"),
        ),
    ] {
        // Serialize via the same domain type so object-key order is canonical.
        let input: console_compliance_adapter_postgres::rights::Filing =
            serde_json::from_value(input).unwrap();
        let payload = serde_json::to_string(&input).unwrap();
        let id = actor.id;
        let envelope = step_up_as(
            &pool,
            &svc,
            &mut actor,
            MobileStepUpActionKind::PrivacyRequest,
            id,
            &payload,
        )
        .await;
        let mut body = serde_json::to_value(input).unwrap();
        body["step_up"] = envelope;
        let key = Uuid::new_v4().to_string();
        let (status, answer) =
            period_unlock_support::send(&service, uri, &actor.token, Some(&key), body.clone())
                .await;
        if let Some(code) = expected {
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
            assert_eq!(answer["error"]["code"], code);
        } else {
            assert_eq!(status, StatusCode::OK, "{answer}");
            let (status, replay) =
                period_unlock_support::send(&service, uri, &actor.token, Some(&key), body.clone())
                    .await;
            assert_eq!(status, StatusCode::OK, "{replay}");
            assert_eq!(replay, answer);
            body["detail"] = json!("Changed");
            let (status, _) =
                period_unlock_support::send(&service, uri, &actor.token, Some(&key), body.clone())
                    .await;
            assert_eq!(status, StatusCode::CONFLICT);
            let fresh_key = Uuid::new_v4().to_string();
            let (status, refused) =
                period_unlock_support::send(&service, uri, &actor.token, Some(&fresh_key), body)
                    .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
            assert_eq!(refused["error"]["code"], "passkey_step_up_failed");
        }
    }
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(actor.id)
        .execute(&pool)
        .await
        .unwrap();
    actor.token =
        period_unlock_support::session_token(&pool, &issuer, org, actor.id, "SUPER_ADMIN").await;
    let input = json!({"controller":"TENANT","kinds":["ACCESS"],"detail":""});
    let filing: console_compliance_adapter_postgres::rights::Filing =
        serde_json::from_value(input.clone()).unwrap();
    let payload = serde_json::to_string(&filing).unwrap();
    let id = actor.id;
    let envelope = step_up_as(
        &pool,
        &svc,
        &mut actor,
        MobileStepUpActionKind::PrivacyRequest,
        id,
        &payload,
    )
    .await;
    let mut body = input;
    body["step_up"] = envelope;
    let (status, refusal) = send(&service, "POST", uri, Some(&actor.token), Some(body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refusal}");
    assert_eq!(refusal["error"]["code"], "no_employee_record");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM privacy_rights_requests WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "refusals and replays must not create requests");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_step_up_kind_preserves_existing_ceremony_bindings(pool: PgPool) {
    use console_platform_auth::MobileStepUpActionKind;
    for kind in MobileStepUpActionKind::ALL {
        let ceremony = Uuid::new_v4();
        sqlx::query("INSERT INTO auth_webauthn_ceremonies(id,user_id,ceremony_kind,challenge_json,state_json,expires_at) VALUES ($1,NULL,'authentication','{}','{}',now()+interval '1 minute')")
            .bind(ceremony).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO auth_webauthn_ceremony_bindings(ceremony_id,action_kind,object_id,reason_key,replay_attempt,payload_hash) VALUES ($1,$2,$3,$4,NULL,$5)")
            .bind(ceremony).bind(kind.as_wire()).bind(Uuid::new_v4()).bind(kind.expected_reason_key())
            .bind((!kind.is_legacy()).then(|| "ab".repeat(32))).execute(&pool).await.unwrap();
    }
}

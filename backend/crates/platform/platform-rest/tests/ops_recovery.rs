// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "fixtures/rename.rs"]
mod fixture;
#[path = "fixtures/ops_recovery.rs"]
mod recovery;
use console_kernel_core::{OrgId, UserId};
use console_platform_provisioning::OpsRecoveryCommand;
use fixture::Harness;
use http::StatusCode;
use recovery::*;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_http_refusal_codes(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org = h.onboard("recovery-http").await;
    let (a, mut ak, at) = operator(&h).await;
    let (b, mut bk, _) = operator(&h).await;
    let id = Uuid::new_v4();
    code(
        send(&h, a, &mut ak, &at, org, id, open()).await,
        StatusCode::CONFLICT,
        "ops_recovery_not_enrolled",
    );
    enrolled(&h, org).await;
    sqlx::query("UPDATE users SET is_active=false WHERE org_id=$1 AND id<>$2")
        .bind(OrgId::platform().as_uuid())
        .bind(a.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    code(
        send(&h, a, &mut ak, &at, org, id, open()).await,
        StatusCode::CONFLICT,
        "ops_recovery_no_second_operator",
    );
    sqlx::query("UPDATE users SET is_active=true WHERE id=$1")
        .bind(b.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    let bt = h
        .token_for(b, OrgId::platform(), true, vec!["SUPER_ADMIN".into()])
        .await;
    for evidence in [
        "901231-1234567",
        "９０１２３１ - １２３４５６７",
        "9 0 1 2 3 1 - 1 2 3 4 5 6 7",
        "901231‐1234567",
        "901231‑1234567",
        "901231‒1234567",
        "901231–1234567",
        "901231—1234567",
        "901231―1234567",
        "901231－1234567",
        "901231_1234567",
        "901231.1234567",
    ] {
        let mut command = open();
        if let OpsRecoveryCommand::Open { evidence_ref, .. } = &mut command {
            *evidence_ref = evidence.into();
        }
        code(
            send(&h, a, &mut ak, &at, org, Uuid::new_v4(), command).await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "ops_recovery_evidence_identifier",
        );
    }
    assert_eq!(
        send(&h, a, &mut ak, &at, org, id, open()).await.0,
        StatusCode::OK
    );
    code(
        send(&h, a, &mut ak, &at, org, Uuid::new_v4(), open()).await,
        StatusCode::CONFLICT,
        "ops_recovery_already_open",
    );
    code(
        send(&h, a, &mut ak, &at, org, id, OpsRecoveryCommand::Approve).await,
        StatusCode::FORBIDDEN,
        "ops_recovery_sod_requester",
    );
    code(
        send(&h, a, &mut ak, &at, org, id, OpsRecoveryCommand::Issue).await,
        StatusCode::CONFLICT,
        "ops_recovery_not_approved",
    );
    // An owner-planted shared-credential record represents the cross-account shared-authenticator refusal.
    let open_assertion: Uuid =
        sqlx::query_scalar("SELECT open_assertion FROM ops_recovery_requests WHERE id=$1")
            .bind(id)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    sqlx::query("UPDATE step_up_assertions SET credential_row_id=(SELECT id FROM auth_webauthn_credentials WHERE user_id=$2) WHERE ceremony_id=$1").bind(open_assertion).bind(b.as_uuid()).execute(&h.owner).await.unwrap();
    code(
        send(&h, b, &mut bk, &bt, org, id, OpsRecoveryCommand::Approve).await,
        StatusCode::FORBIDDEN,
        "ops_recovery_shared_authenticator",
    );
    sqlx::query("UPDATE step_up_assertions SET credential_row_id=(SELECT id FROM auth_webauthn_credentials WHERE user_id=$2) WHERE ceremony_id=$1").bind(open_assertion).bind(a.as_uuid()).execute(&h.owner).await.unwrap();
    assert_eq!(
        send(&h, b, &mut bk, &bt, org, id, OpsRecoveryCommand::Approve)
            .await
            .0,
        StatusCode::OK
    );
    let hold = send(&h, a, &mut ak, &at, org, id, OpsRecoveryCommand::Issue).await;
    assert!(hold.1["error"]["hold_until"].is_string());
    code(hold, StatusCode::CONFLICT, "ops_recovery_hold_active");
    assert_eq!(
        send(
            &h,
            a,
            &mut ak,
            &at,
            org,
            id,
            OpsRecoveryCommand::Cancel {
                reason: "Controller withdrew authorization".into()
            }
        )
        .await
        .0,
        StatusCode::OK
    );
    code(
        send(&h, b, &mut bk, &bt, org, id, OpsRecoveryCommand::Issue).await,
        StatusCode::CONFLICT,
        "ops_recovery_cancelled",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_http_step_up_and_tier_boundaries(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org = h.onboard("recovery-boundary").await;
    let target = enrolled(&h, org).await;
    let (a, mut ak, at) = operator(&h).await;
    let (b, mut bk, bt) = operator(&h).await;
    let id = Uuid::new_v4();
    let path = format!("/api/platform/orgs/{org}/ops-recovery");
    let body = json!({"id":id,"authoriser_role":"REPRESENTATIVE","authoriser_name":"Customer controller","proofing_method":"REPEATED_PROOFING","evidence_ref":"TICKET-12345678"});
    code(
        h.send_as_with_key(
            "POST",
            &path,
            body.clone(),
            &at,
            Some(&Uuid::new_v4().to_string()),
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    );
    let mut foreign = body.clone();
    foreign["step_up"] = proof(&h, b, &mut bk, org, id, &open()).await;
    code(
        h.send_as_with_key(
            "POST",
            &path,
            foreign,
            &at,
            Some(&Uuid::new_v4().to_string()),
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    );
    let unkeyed = UserId::new();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'No passkey',ARRAY['SUPER_ADMIN'])").bind(unkeyed.as_uuid()).bind(OrgId::platform().as_uuid()).execute(&h.owner).await.unwrap();
    let unkeyed_token = h
        .token_for(unkeyed, OrgId::platform(), true, vec!["SUPER_ADMIN".into()])
        .await;
    code(
        h.send_as_with_key(
            "POST",
            &path,
            body.clone(),
            &unkeyed_token,
            Some(&Uuid::new_v4().to_string()),
        )
        .await,
        StatusCode::FORBIDDEN,
        "passkey_required",
    );
    let tenant = h
        .token_for(
            target,
            OrgId::from_uuid(org),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    assert_eq!(
        h.send_as_with_key(
            "POST",
            &path,
            body,
            &tenant,
            Some(&Uuid::new_v4().to_string())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(&h, a, &mut ak, &at, org, id, open()).await.0,
        StatusCode::OK
    );
    let cancel = format!("/api/v1/tenant/ops-recovery/{id}/cancel");
    assert_eq!(
        h.send_as_with_key(
            "POST",
            &cancel,
            json!({"reason":"Stop"}),
            &bt,
            Some(&Uuid::new_v4().to_string())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let other = h.onboard("recovery-foreign").await;
    let other_user = enrolled(&h, other).await;
    let other_token = h
        .token_for(
            other_user,
            OrgId::from_uuid(other),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    code(
        h.send_as_with_key(
            "POST",
            &cancel,
            json!({"reason":"Stop"}),
            &other_token,
            Some(&Uuid::new_v4().to_string()),
        )
        .await,
        StatusCode::NOT_FOUND,
        "not_found",
    );
    // The third operator is active but is not a requester or approver.
    code(
        send(&h, b, &mut bk, &bt, org, id, OpsRecoveryCommand::Issue).await,
        StatusCode::FORBIDDEN,
        "forbidden",
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_recovery_tenant_reads_hide_evidence_and_fresh_step_up_cancels_the_hold(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org = h.onboard("recovery-tenant-cancel").await;
    let (target, mut held, token) = tenant(&h, org).await;
    let (a, mut ak, at) = operator(&h).await;
    let (b, mut bk, bt) = operator(&h).await;
    let id = Uuid::new_v4();
    assert_eq!(
        send(&h, a, &mut ak, &at, org, id, open()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        send(&h, b, &mut bk, &bt, org, id, OpsRecoveryCommand::Approve)
            .await
            .0,
        StatusCode::OK
    );
    assert_read_redaction(&h, &at, &token, org, id).await;
    let result = tenant_cancel(&h, target, &mut held, &token, org, id).await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    code(
        send(&h, a, &mut ak, &at, org, id, OpsRecoveryCommand::Issue).await,
        StatusCode::CONFLICT,
        "ops_recovery_cancelled",
    );
}

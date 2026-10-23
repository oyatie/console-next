// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod period_unlock_support;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, MobileStepUpActionKind};
use console_platform_test_support::{issue_session_token, soft_passkey::passkey_service};
use http::StatusCode;
use period_unlock_support::{admin, admin_in, router, send, step_up_as};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

async fn platform_token(pool: &PgPool, issuer: &JwtIssuer, id: Uuid) -> String {
    issue_session_token(
        pool,
        issuer,
        AccessTokenInput {
            subject: UserId::from_uuid(id),
            org_id: OrgId::platform(),
            roles: vec!["SUPER_ADMIN".into()],
            branches: vec![],
            platform: true,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: vec![],
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        vec![],
    )
    .await
}
fn refusal(result: (StatusCode, Value), status: StatusCode, code: &str) {
    assert_eq!(result.0, status, "{}", result.1);
    assert_eq!(result.1["error"]["code"], code);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_ops_recovery_is_mounted_and_step_up_is_required(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let ops = admin(&owner, &svc, &issuer, "Recovery ops").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    let vendor = admin_in(&owner, &svc, &issuer, OrgId::platform(), "Recovery vendor").await;
    let token = platform_token(&owner, &issuer, vendor.id).await;
    let path = format!("/api/platform/orgs/{}/ops-recovery", OrgId::one());
    let body = json!({"id":Uuid::new_v4(),"authoriser_role":"REPRESENTATIVE","authoriser_name":"Controller","proofing_method":"ORIGINAL_LEVEL","evidence_ref":"test-reference"});
    refusal(
        send(
            &service,
            &path,
            &token,
            Some(&Uuid::new_v4().to_string()),
            body.clone(),
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    );
    assert_eq!(
        send(
            &service,
            &path,
            &ops.token,
            Some(&Uuid::new_v4().to_string()),
            body
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let tenant_cancel = format!("/api/v1/tenant/ops-recovery/{}/cancel", Uuid::new_v4());
    assert_eq!(
        send(
            &service,
            &tenant_cancel,
            &token,
            Some(&Uuid::new_v4().to_string()),
            json!({"reason":"Stop"})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

/// Regression pins: these deliberately pass on the base as well as this lane.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_pin_platform_ops_recovery_has_no_admin_reset_bypass(owner: PgPool) {
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let ops = admin(&owner, &svc, &issuer, "Only ops holder").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();
    refusal(
        send(
            &service,
            "/api/v1/auth/admin/credential-reset",
            &ops.token,
            None,
            json!({"user_id":ops.id}),
        )
        .await,
        StatusCode::CONFLICT,
        "last_sign_in_path",
    );
    let mut vendor = admin_in(
        &owner,
        &svc,
        &issuer,
        OrgId::platform(),
        "Platform operator",
    )
    .await;
    let token = platform_token(&owner, &issuer, vendor.id).await;
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1")
            .bind(ops.id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(remaining, 1);
    let proof = step_up_as(
        &owner,
        &svc,
        &mut vendor,
        MobileStepUpActionKind::OperatorRecovery,
        Uuid::new_v4(),
        "regression-pin-admin-otp",
    )
    .await;
    let path = format!("/api/platform/orgs/{}/admin-otp", OrgId::one());
    refusal(
        send(
            &service,
            &path,
            &token,
            None,
            json!({"step_up":proof["assertion"]}),
        )
        .await,
        StatusCode::CONFLICT,
        "admin_already_enrolled",
    );
}

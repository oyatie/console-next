// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "platform_second_operator_api/ceremonies.rs"]
mod ceremonies;
#[path = "platform_second_operator_api/helpers.rs"]
mod helpers;

use ceremonies::verify_ops_recovery_and_revoke;
use console_kernel_core::OrgId;
use console_platform_provisioning::{
    BootstrapCredentialStore, PlatformOperatorStepUp, TenantEraseCommand,
};
use console_platform_test_support::{MIGRATOR, runtime_role_pool, soft_passkey::SoftKey};
use helpers::{bound_step_up, build_app_router, complete_otp_passkey_enrolment, req};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "MIGRATOR")]
async fn api_only_second_operator_enrolment_enables_erase_and_ops_recovery_and_revocation_kills_session(
    owner: PgPool,
) {
    let rt = runtime_role_pool(&owner).await;
    let service = build_app_router(rt.clone());
    let cold_otp = "cold-start-op-a-secret-2026";
    assert!(
        BootstrapCredentialStore
            .seed_cold_start_credential(
                &rt,
                cold_otp,
                Duration::hours(1),
                OffsetDateTime::now_utc()
            )
            .await
            .unwrap()
    );

    // Operator A enrols purely through /api/v1/auth/* (no SQL user inserts).
    let mut op_a = complete_otp_passkey_enrolment(&service, cold_otp).await;

    // Onboard two tenants: one archived for #84 erasure, one active for #85 ops recovery.
    let (status, org1) = req(
        &service,
        "POST",
        "/api/platform/orgs",
        Some(&op_a.access_token),
        None,
        Some(json!({ "slug": "erase-target", "name": "Erase Target" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{org1}");
    let erase_org: Uuid = org1["org"]["id"].as_str().unwrap().parse().unwrap();
    let (status, _) = req(
        &service,
        "PATCH",
        &format!("/api/platform/orgs/{erase_org}"),
        Some(&op_a.access_token),
        None,
        Some(json!({ "status": "ARCHIVED" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, org2) = req(
        &service,
        "POST",
        "/api/platform/orgs",
        Some(&op_a.access_token),
        None,
        Some(json!({ "slug": "recovery-target", "name": "Recovery Target" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{org2}");
    let recovery_org: Uuid = org2["org"]["id"].as_str().unwrap().parse().unwrap();
    let recovery_ops_id: Uuid = org2["admin_user_id"].as_str().unwrap().parse().unwrap();
    SoftKey::enroll(
        &owner,
        OrgId::from_uuid(recovery_org),
        console_kernel_core::UserId::from_uuid(recovery_ops_id),
    )
    .await;

    // With only Operator A, both #84 and #85 refuse.
    let erase_req_id = Uuid::new_v4();
    let erase_open_step_up = bound_step_up(
        &service,
        &mut op_a,
        erase_req_id,
        TenantEraseCommand::Open.payload_hash(erase_org, erase_req_id),
    )
    .await;
    let (status, err) = req(
        &service,
        "POST",
        &format!("/api/platform/orgs/{erase_org}/erase"),
        Some(&op_a.access_token),
        None,
        Some(json!({ "id": erase_req_id, "step_up": erase_open_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert_eq!(err["error"]["code"], "erase_requires_second_operator");

    // Operator A invites Operator B via POST /api/platform/operators.
    let op_b_id = Uuid::new_v4();
    let invite_step_up = bound_step_up(
        &service,
        &mut op_a,
        op_b_id,
        PlatformOperatorStepUp::invite_payload_hash(op_b_id, "Operator Beta", Some("op.beta"))
            .unwrap(),
    )
    .await;
    let (status, invited) = req(
        &service,
        "POST",
        "/api/platform/operators",
        Some(&op_a.access_token),
        None,
        Some(json!({
            "id": op_b_id,
            "display_name": "Operator Beta",
            "login": "op.beta",
            "step_up": invite_step_up,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{invited}");
    let b_invite_token = invited["invite_token"].as_str().unwrap().to_owned();

    // While Operator B is still unkeyed, #84 still refuses!
    let erase_open_step_up = bound_step_up(
        &service,
        &mut op_a,
        erase_req_id,
        TenantEraseCommand::Open.payload_hash(erase_org, erase_req_id),
    )
    .await;
    let (status, err) = req(
        &service,
        "POST",
        &format!("/api/platform/orgs/{erase_org}/erase"),
        Some(&op_a.access_token),
        None,
        Some(json!({ "id": erase_req_id, "step_up": erase_open_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert_eq!(err["error"]["code"], "erase_requires_second_operator");

    // Operator B completes API-only enrolment (redeem -> consent -> passkey register -> passkey login).
    let mut op_b = complete_otp_passkey_enrolment(&service, &b_invite_token).await;

    // #84 Tenant erasure two-operator ceremony: A opens -> A self-approve fails -> B approves!
    let erase_open_step_up = bound_step_up(
        &service,
        &mut op_a,
        erase_req_id,
        TenantEraseCommand::Open.payload_hash(erase_org, erase_req_id),
    )
    .await;
    let (status, opened) = req(
        &service,
        "POST",
        &format!("/api/platform/orgs/{erase_org}/erase"),
        Some(&op_a.access_token),
        None,
        Some(json!({ "id": erase_req_id, "step_up": erase_open_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{opened}");

    let self_approve_step_up = bound_step_up(
        &service,
        &mut op_a,
        erase_req_id,
        TenantEraseCommand::Approve.payload_hash(erase_org, erase_req_id),
    )
    .await;
    let (status, self_refused) = req(
        &service,
        "POST",
        &format!("/api/platform/orgs/{erase_org}/erase/{erase_req_id}/approve"),
        Some(&op_a.access_token),
        None,
        Some(json!({ "step_up": self_approve_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{self_refused}");
    assert_eq!(self_refused["error"]["code"], "erase_same_operator");

    let b_approve_step_up = bound_step_up(
        &service,
        &mut op_b,
        erase_req_id,
        TenantEraseCommand::Approve.payload_hash(erase_org, erase_req_id),
    )
    .await;
    let (status, approved) = req(
        &service,
        "POST",
        &format!("/api/platform/orgs/{erase_org}/erase/{erase_req_id}/approve"),
        Some(&op_b.access_token),
        None,
        Some(json!({ "step_up": b_approve_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert!(approved["cooling_until"].is_string());

    verify_ops_recovery_and_revoke(
        &service,
        &mut op_a,
        &mut op_b,
        op_b_id,
        recovery_org,
        erase_org,
    )
    .await;
}

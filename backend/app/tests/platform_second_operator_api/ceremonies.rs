// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::Router;
use console_kernel_core::OrgId;
use console_platform_provisioning::{OpsRecoveryCommand, PlatformOperatorStepUp};
use http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

use super::helpers::{EnrolledSession, bound_step_up, req};

pub async fn verify_ops_recovery_and_revoke(
    service: &Router,
    op_a: &mut EnrolledSession,
    op_b: &mut EnrolledSession,
    op_b_id: Uuid,
    recovery_org: Uuid,
    erase_org: Uuid,
) {
    // #85 Ops recovery two-operator ceremony: A opens -> A self-approve fails -> B approves!
    let rec_id = Uuid::new_v4();
    let rec_cmd = OpsRecoveryCommand::Open {
        authoriser_role: "REPRESENTATIVE".into(),
        authoriser_name: "Controller".into(),
        proofing_method: "REPEATED_PROOFING".into(),
        evidence_ref: "TICKET-8501".into(),
    };
    let rec_open_step_up = bound_step_up(
        service,
        op_a,
        rec_id,
        rec_cmd
            .payload_hash(OrgId::from_uuid(recovery_org), rec_id)
            .unwrap(),
    )
    .await;
    let (status, rec_opened) = req(
        service,
        "POST",
        &format!("/api/platform/orgs/{recovery_org}/ops-recovery"),
        Some(&op_a.access_token),
        Some(&Uuid::new_v4().to_string()),
        Some(json!({
            "id": rec_id,
            "authoriser_role": "REPRESENTATIVE",
            "authoriser_name": "Controller",
            "proofing_method": "REPEATED_PROOFING",
            "evidence_ref": "TICKET-8501",
            "step_up": rec_open_step_up,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rec_opened}");

    let rec_self_step_up = bound_step_up(
        service,
        op_a,
        rec_id,
        OpsRecoveryCommand::Approve
            .payload_hash(OrgId::from_uuid(recovery_org), rec_id)
            .unwrap(),
    )
    .await;
    let (status, rec_self_refused) = req(
        service,
        "POST",
        &format!("/api/platform/orgs/{recovery_org}/ops-recovery/{rec_id}/approve"),
        Some(&op_a.access_token),
        Some(&Uuid::new_v4().to_string()),
        Some(json!({ "step_up": rec_self_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{rec_self_refused}");
    assert_eq!(
        rec_self_refused["error"]["code"],
        "ops_recovery_sod_requester"
    );

    let rec_b_step_up = bound_step_up(
        service,
        op_b,
        rec_id,
        OpsRecoveryCommand::Approve
            .payload_hash(OrgId::from_uuid(recovery_org), rec_id)
            .unwrap(),
    )
    .await;
    let (status, rec_approved) = req(
        service,
        "POST",
        &format!("/api/platform/orgs/{recovery_org}/ops-recovery/{rec_id}/approve"),
        Some(&op_b.access_token),
        Some(&Uuid::new_v4().to_string()),
        Some(json!({ "step_up": rec_b_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rec_approved}");

    // Operator A revokes Operator B -> B's JWT and refresh token immediately return 401.
    let revoke_step_up = bound_step_up(
        service,
        op_a,
        op_b_id,
        PlatformOperatorStepUp::revoke_payload_hash(op_b_id, Some("rotation")).unwrap(),
    )
    .await;
    let (status, revoked) = req(
        service,
        "POST",
        &format!("/api/platform/operators/{op_b_id}/revoke"),
        Some(&op_a.access_token),
        None,
        Some(json!({ "reason": "rotation", "step_up": revoke_step_up })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert_eq!(revoked["status"], "REVOKED");

    let (jwt_status, _) = req(
        service,
        "GET",
        "/api/platform/orgs",
        Some(&op_b.access_token),
        None,
        None,
    )
    .await;
    assert_eq!(jwt_status, StatusCode::UNAUTHORIZED);

    let (refresh_status, _) = req(
        service,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        None,
        Some(json!({ "refresh_token": op_b.refresh_token })),
    )
    .await;
    assert_eq!(refresh_status, StatusCode::UNAUTHORIZED);

    // Second operator availability drops back to false on #84 and #85.
    let (status, erase_read): (StatusCode, Value) = req(
        service,
        "GET",
        &format!("/api/platform/orgs/{erase_org}/erase"),
        Some(&op_a.access_token),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(erase_read["second_operator_available"], false);
}

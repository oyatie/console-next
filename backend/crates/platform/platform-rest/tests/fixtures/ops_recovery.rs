// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::Harness;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_provisioning::OpsRecoveryCommand;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use http::StatusCode;
use serde_json::{Value, json};
use uuid::Uuid;

pub(super) async fn operator(h: &Harness) -> (UserId, SoftKey, String) {
    let user = UserId::new();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Recovery operator',ARRAY['SUPER_ADMIN'])").bind(user.as_uuid()).bind(OrgId::platform().as_uuid()).execute(&h.owner).await.unwrap();
    let key = SoftKey::enroll(&h.owner, OrgId::platform(), user).await;
    let token = h
        .token_for(user, OrgId::platform(), true, vec!["SUPER_ADMIN".into()])
        .await;
    (user, key, token)
}
pub(super) fn open() -> OpsRecoveryCommand {
    OpsRecoveryCommand::Open {
        authoriser_role: "REPRESENTATIVE".into(),
        authoriser_name: "Customer controller".into(),
        proofing_method: "REPEATED_PROOFING".into(),
        evidence_ref: "TICKET-12345678".into(),
    }
}
pub(super) async fn proof(
    h: &Harness,
    user: UserId,
    key: &mut SoftKey,
    org: Uuid,
    id: Uuid,
    command: &OpsRecoveryCommand,
) -> Value {
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::OperatorRecovery,
        id,
        command.payload_hash(OrgId::from_uuid(org), id).unwrap(),
    );
    let start = passkey_service()
        .start_mobile_step_up(&h.owner, *user.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}})
}
pub(super) async fn send(
    h: &Harness,
    user: UserId,
    key: &mut SoftKey,
    token: &str,
    org: Uuid,
    id: Uuid,
    command: OpsRecoveryCommand,
) -> (StatusCode, Value) {
    let step_up = proof(h, user, key, org, id, &command).await;
    let mut body = serde_json::to_value(&command).unwrap();
    body.as_object_mut().unwrap().remove("action");
    body["step_up"] = step_up;
    let path = if matches!(command, OpsRecoveryCommand::Open { .. }) {
        body["id"] = json!(id);
        format!("/api/platform/orgs/{org}/ops-recovery")
    } else {
        format!(
            "/api/platform/orgs/{org}/ops-recovery/{id}/{}",
            command.action()
        )
    };
    h.send_as_with_key(
        "POST",
        &path,
        body,
        token,
        Some(&Uuid::new_v4().to_string()),
    )
    .await
}
pub(super) fn code(result: (StatusCode, Value), status: StatusCode, code: &str) {
    assert_eq!(result.0, status, "{}", result.1);
    assert_eq!(result.1["error"]["code"], code);
    assert!(result.1["error"]["support_ref"].is_string());
}
pub(super) async fn enrolled(h: &Harness, org: Uuid) -> UserId {
    let target: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops")
        .bind(org)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    SoftKey::enroll(&h.owner, OrgId::from_uuid(org), UserId::from_uuid(target)).await;
    UserId::from_uuid(target)
}

pub(super) async fn tenant(h: &Harness, org: Uuid) -> (UserId, SoftKey, String) {
    let user = enrolled(h, org).await;
    let key = SoftKey::enroll(&h.owner, OrgId::from_uuid(org), user).await;
    let token = h
        .token_for(
            user,
            OrgId::from_uuid(org),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    (user, key, token)
}

pub(super) async fn assert_read_redaction(
    h: &Harness,
    vendor: &str,
    tenant: &str,
    org: Uuid,
    id: Uuid,
) {
    let (status, read) = h
        .send_as(
            "GET",
            &format!("/api/platform/orgs/{org}/ops-recovery"),
            Value::Null,
            vendor,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["request"]["evidence_ref"], "TICKET-12345678");
    let (status, read) = h
        .send_as("GET", "/api/v1/tenant/ops-recovery", Value::Null, tenant)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["state"], "HOLD");
    assert_eq!(read["request"]["id"], id.to_string());
    assert!(read["request"]["hold_until"].is_string());
    assert!(
        read["request"]["requested_by_name"]
            .as_str()
            .is_some_and(|name| !name.is_empty())
    );
    assert_ne!(
        read["request"]["requested_by_name"],
        read["request"]["requested_by"]
    );
    for field in [
        "evidence_ref",
        "authoriser_name",
        "authoriser_role",
        "proofing_method",
    ] {
        assert!(
            read["request"].get(field).is_none(),
            "tenant cannot see {field}: {read}"
        );
    }
}

pub(super) async fn tenant_cancel(
    h: &Harness,
    user: UserId,
    key: &mut SoftKey,
    token: &str,
    org: Uuid,
    id: Uuid,
) -> (StatusCode, Value) {
    let command = OpsRecoveryCommand::Cancel {
        reason: "Controller cancelled recovery".into(),
    };
    let step_up = proof(h, user, key, org, id, &command).await;
    h.send_as_with_key(
        "POST",
        &format!("/api/v1/tenant/ops-recovery/{id}/cancel"),
        json!({"reason":"Controller cancelled recovery","step_up":step_up}),
        token,
        Some(&Uuid::new_v4().to_string()),
    )
    .await
}

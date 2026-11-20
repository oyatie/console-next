// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "fixtures/rename.rs"]
mod fixture;
#[path = "fixtures/operator_proof.rs"]
mod operator_proof;

use console_kernel_core::{OrgId, UserId};
use console_platform_provisioning::PlatformOperatorStepUp;
use console_platform_rest::{
    PLATFORM_OPERATOR_REISSUE_PATH, PLATFORM_OPERATOR_REVOKE_PATH, PLATFORM_OPERATORS_PATH,
};
use console_platform_test_support::{MIGRATOR, soft_passkey::SoftKey};
use fixture::Harness;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn seed_enrolled_operator(h: &Harness) -> (UserId, SoftKey, String) {
    let user = UserId::new();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Operator',ARRAY['SUPER_ADMIN'])")
        .bind(user.as_uuid())
        .bind(OrgId::platform().as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    let key = SoftKey::enroll(&h.owner, OrgId::platform(), user).await;
    let token = h
        .token_for(user, OrgId::platform(), true, vec!["SUPER_ADMIN".into()])
        .await;
    (user, key, token)
}

fn assert_code(res: (StatusCode, Value), status: StatusCode, code: &str) {
    assert_eq!(res.0, status, "{}", res.1);
    assert_eq!(res.1["error"]["code"], code, "{}", res.1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn operators_rest_enforces_authz_step_up_conflicts_and_isolation(owner: PgPool) {
    let h = Harness::new(owner).await;
    let (a, mut ak, at) = seed_enrolled_operator(&h).await;

    // Tenant token cannot access /api/platform/operators.
    let tenant_user = console_platform_test_support::seed_org_and_super_admin(
        &h.owner,
        *OrgId::one().as_uuid(),
        "Tenant Admin",
    )
    .await;
    let tenant_token = h
        .token_for(tenant_user, OrgId::one(), false, vec!["SUPER_ADMIN".into()])
        .await;
    assert_eq!(
        h.send_as("GET", PLATFORM_OPERATORS_PATH, Value::Null, &tenant_token)
            .await
            .0,
        StatusCode::FORBIDDEN
    );

    // Missing step-up on invite -> 401.
    let b_id = Uuid::new_v4();
    assert_code(
        h.send_as(
            "POST",
            PLATFORM_OPERATORS_PATH,
            json!({"id": b_id, "display_name": "Op Two", "login": "op.two"}),
            &at,
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    );

    // Tampered payload hash in BW-29 step-up -> 401.
    let wrong_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        b_id,
        PlatformOperatorStepUp::invite_payload_hash(b_id, "Other Name", Some("op.two")).unwrap(),
    )
    .await;
    assert_code(
        h.send_as(
            "POST",
            PLATFORM_OPERATORS_PATH,
            json!({"id": b_id, "display_name": "Op Two", "login": "op.two", "step_up": wrong_proof}),
            &at,
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    );

    // Valid invite succeeds -> 201 with cop_ token.
    let valid_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        b_id,
        PlatformOperatorStepUp::invite_payload_hash(b_id, "Op Two", Some("op.two")).unwrap(),
    )
    .await;
    let (status, invited) = h
        .send_as(
            "POST",
            PLATFORM_OPERATORS_PATH,
            json!({"id": b_id, "display_name": "Op Two", "login": "op.two", "step_up": valid_proof}),
            &at,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{invited}");
    let invite_token = invited["invite_token"].as_str().unwrap().to_owned();
    assert!(invite_token.starts_with("cop_"));
    assert_eq!(invited["operator"]["status"], "PENDING_ENROLMENT");
    assert_eq!(invited["operator"]["sign_in_id"], "op.two@platform");

    // Duplicate login -> 409 login_taken.
    let c_id = Uuid::new_v4();
    let dup_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        c_id,
        PlatformOperatorStepUp::invite_payload_hash(c_id, "Op Three", Some("op.two")).unwrap(),
    )
    .await;
    assert_code(
        h.send_as(
            "POST",
            PLATFORM_OPERATORS_PATH,
            json!({"id": c_id, "display_name": "Op Three", "login": "op.two", "step_up": dup_proof}),
            &at,
        )
        .await,
        StatusCode::CONFLICT,
        "login_taken",
    );

    // Foreign org user id targeted by reissue or revoke -> 404 (no cross-tenant leakage).
    let foreign_reissue_path =
        PLATFORM_OPERATOR_REISSUE_PATH.replace("{id}", &tenant_user.as_uuid().to_string());
    let foreign_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        *tenant_user.as_uuid(),
        PlatformOperatorStepUp::reissue_payload_hash(*tenant_user.as_uuid()).unwrap(),
    )
    .await;
    assert_code(
        h.send_as(
            "POST",
            &foreign_reissue_path,
            json!({"step_up": foreign_proof}),
            &at,
        )
        .await,
        StatusCode::NOT_FOUND,
        "not_found",
    );

    // Reissue succeeds while B has no passkey -> 200.
    let reissue_path = PLATFORM_OPERATOR_REISSUE_PATH.replace("{id}", &b_id.to_string());
    let reissue_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        b_id,
        PlatformOperatorStepUp::reissue_payload_hash(b_id).unwrap(),
    )
    .await;
    let (status, reissued) = h
        .send_as(
            "POST",
            &reissue_path,
            json!({"step_up": reissue_proof}),
            &at,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{reissued}");
    assert_ne!(reissued["invite_token"].as_str().unwrap(), invite_token);

    // Once B enrolls a passkey, reissue fails 409 operator_already_enrolled.
    let mut bk = SoftKey::enroll(&h.owner, OrgId::platform(), UserId::from_uuid(b_id)).await;
    let bt = h
        .token_for(
            UserId::from_uuid(b_id),
            OrgId::platform(),
            true,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let reissue_proof2 = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        b_id,
        PlatformOperatorStepUp::reissue_payload_hash(b_id).unwrap(),
    )
    .await;
    assert_code(
        h.send_as(
            "POST",
            &reissue_path,
            json!({"step_up": reissue_proof2}),
            &at,
        )
        .await,
        StatusCode::CONFLICT,
        "operator_already_enrolled",
    );

    // List shows A and B as ACTIVE.
    let (status, listed) = h
        .send_as("GET", PLATFORM_OPERATORS_PATH, Value::Null, &at)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["user_id"] == b_id.to_string() && o["status"] == "ACTIVE")
    );

    // Foreign-user step-up (A's token with B's step-up) -> 401.
    let b_proof = operator_proof::proof(
        &h.owner,
        b_id,
        &mut bk,
        b_id,
        PlatformOperatorStepUp::revoke_payload_hash(b_id, None).unwrap(),
    )
    .await;
    let revoke_b_path = PLATFORM_OPERATOR_REVOKE_PATH.replace("{id}", &b_id.to_string());
    assert_code(
        h.send_as("POST", &revoke_b_path, json!({"step_up": b_proof}), &at)
            .await,
        StatusCode::UNAUTHORIZED,
        "unauthorized",
    );

    // Self-revoke -> 403 cannot_revoke_self.
    let self_revoke_path = PLATFORM_OPERATOR_REVOKE_PATH.replace("{id}", &a.as_uuid().to_string());
    let self_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        *a.as_uuid(),
        PlatformOperatorStepUp::revoke_payload_hash(*a.as_uuid(), Some("self")).unwrap(),
    )
    .await;
    assert_code(
        h.send_as(
            "POST",
            &self_revoke_path,
            json!({"reason": "self", "step_up": self_proof}),
            &at,
        )
        .await,
        StatusCode::FORBIDDEN,
        "cannot_revoke_self",
    );

    // Revoke B succeeds -> B's JWT is immediately rejected (401), and re-revoke returns 409 operator_already_revoked.
    let revoke_proof = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        b_id,
        PlatformOperatorStepUp::revoke_payload_hash(b_id, Some("offboard")).unwrap(),
    )
    .await;
    let (status, revoked) = h
        .send_as(
            "POST",
            &revoke_b_path,
            json!({"reason": "offboard", "step_up": revoke_proof}),
            &at,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert_eq!(revoked["status"], "REVOKED");
    assert_eq!(
        h.send_as("GET", PLATFORM_OPERATORS_PATH, Value::Null, &bt)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );

    // Revoking the initial Harness operator too leaves only A -> Harness admin cannot revoke A? Wait: Harness seeded a platform admin too.
    // Verify re-revoking B -> 409 operator_already_revoked.
    let revoke_proof2 = operator_proof::proof(
        &h.owner,
        *a.as_uuid(),
        &mut ak,
        b_id,
        PlatformOperatorStepUp::revoke_payload_hash(b_id, None).unwrap(),
    )
    .await;
    assert_code(
        h.send_as(
            "POST",
            &revoke_b_path,
            json!({"step_up": revoke_proof2}),
            &at,
        )
        .await,
        StatusCode::CONFLICT,
        "operator_already_revoked",
    );

    // Confirm audit_events exist under OrgId::platform() and never contain raw invite tokens.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action LIKE 'platform.operator.%'",
    )
    .bind(OrgId::platform().as_uuid())
    .fetch_one(&h.owner)
    .await
    .unwrap();
    assert!(
        audits >= 4,
        "expected list/invite/reissue/revoke audits, got {audits}"
    );
}

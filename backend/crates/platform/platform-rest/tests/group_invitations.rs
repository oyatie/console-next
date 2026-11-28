// SPDX-License-Identifier: LicenseRef-Proprietary
//! End-to-end PostgreSQL integration test for 7-day group join invitations (BG-12a).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "fixtures/rename.rs"]
#[allow(dead_code)]
mod fixture;

use console_kernel_core::{OrgId, UserId};
use console_platform_rest::PLATFORM_GROUPS_PATH;
use console_platform_test_support::soft_passkey::SoftKey;
use fixture::Harness;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn group_join_invitation_lifecycle_accept_decline_and_cancel(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org_a_uuid = h.onboard("inv-alpha").await;
    let org_b_uuid = h.onboard("inv-beta").await;
    let org_a = OrgId::from_uuid(org_a_uuid);
    let org_b = OrgId::from_uuid(org_b_uuid);

    let ops_a_uuid: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id = $1 LIMIT 1")
        .bind(org_a_uuid)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let ops_b_uuid: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id = $1 LIMIT 1")
        .bind(org_b_uuid)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let ops_a = UserId::from_uuid(ops_a_uuid);
    let ops_b = UserId::from_uuid(ops_b_uuid);
    let member_a =
        console_platform_test_support::seed_active_user(&h.owner, org_a_uuid, "MEMBER", "HR").await;

    let mut ops_a_key = SoftKey::enroll(&h.owner, org_a, ops_a).await;
    let ops_a_token = h
        .token_for(ops_a, org_a, false, vec!["SUPER_ADMIN".into()])
        .await;
    let member_a_token = h
        .token_for(member_a, org_a, false, vec!["MEMBER".into()])
        .await;
    let ops_b_token = h
        .token_for(ops_b, org_b, false, vec!["SUPER_ADMIN".into()])
        .await;

    let (status, created_group) = h
        .send(
            "POST",
            PLATFORM_GROUPS_PATH,
            json!({ "slug": "inv-group", "name": "Invitation Group" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created_group}");
    let group_id = Uuid::parse_str(created_group["id"].as_str().unwrap()).unwrap();

    // Create 7-day invitation for org_a (requires platform operator step-up).
    let admin_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM users WHERE org_id = $1 AND display_name = 'Platform Admin' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(*OrgId::platform().as_uuid())
    .fetch_one(&h.owner)
    .await
    .unwrap();
    let mut admin_key =
        SoftKey::enroll(&h.owner, OrgId::platform(), UserId::from_uuid(admin_id)).await;

    let (status, inv_a) = h
        .send(
            "POST",
            &format!("/api/platform/groups/{group_id}/invitations"),
            json!({
                "org_id": org_a_uuid,
                "step_up": admin_key.step_up(&h.owner).await,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{inv_a}");
    let inv_a_id = inv_a["id"].as_str().unwrap().to_owned();
    assert_eq!(inv_a["status"], "PENDING");

    // Duplicate pending invitation is refused with 409.
    let (status, _) = h
        .send(
            "POST",
            &format!("/api/platform/groups/{group_id}/invitations"),
            json!({
                "org_id": org_a_uuid,
                "step_up": admin_key.step_up(&h.owner).await,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Group listing includes pending_invitations.
    let (status, groups) = h.send("GET", PLATFORM_GROUPS_PATH, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let grp = groups
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == group_id.to_string())
        .unwrap();
    assert_eq!(grp["pending_invitations"].as_array().unwrap().len(), 1);

    // Non-ops member cannot list tenant invitations (403); ops holder can (200).
    let (status, _) = h
        .send_as(
            "GET",
            "/api/v1/tenant/group-invitations",
            Value::Null,
            &member_a_token,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, tenant_list) = h
        .send_as(
            "GET",
            "/api/v1/tenant/group-invitations",
            Value::Null,
            &ops_a_token,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{tenant_list}");
    assert_eq!(tenant_list["items"].as_array().unwrap().len(), 1);

    // Accepting requires fresh passkey step-up from the tenant ops holder.
    let accept = format!("/api/v1/tenant/group-invitations/{inv_a_id}/accept");
    let (status, unauthenticated) = h.send_as("POST", &accept, json!({}), "invalid").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(unauthenticated["error"]["code"], "unauthorized");
    let _member_key = SoftKey::enroll(&h.owner, org_a, member_a).await;
    let (status, refusal) = h.send_as("POST", &accept, json!({}), &member_a_token).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refusal}");
    assert_eq!(refusal["error"]["code"], "forbidden");
    let (status, challenge) = h.send_as("POST", &accept, json!({}), &ops_a_token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(challenge["error"]["code"], "passkey_step_up_required");
    let body = json!({ "step_up": ops_a_key.step_up(&h.owner).await });
    let (status, joined_org) = h.send_as("POST", &accept, body.clone(), &ops_a_token).await;
    assert_eq!(status, StatusCode::OK, "{joined_org}");
    assert_eq!(joined_org["group_id"], group_id.to_string());
    let (status, used_assertion) = h.send_as("POST", &accept, body, &ops_a_token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(used_assertion["error"]["code"], "passkey_step_up_failed");

    // Invite org_b, decline as ops_b, then invite org_b again and cancel as platform operator.
    let (status, inv_b1) = h
        .send(
            "POST",
            &format!("/api/platform/groups/{group_id}/invitations"),
            json!({
                "org_id": org_b_uuid,
                "step_up": admin_key.step_up(&h.owner).await,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let inv_b1_id = inv_b1["id"].as_str().unwrap();
    let (status, enrollment) = h
        .send_as(
            "POST",
            &format!("/api/v1/tenant/group-invitations/{inv_b1_id}/accept"),
            json!({}),
            &ops_b_token,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(enrollment["error"]["code"], "passkey_required");

    let (status, _) = h
        .send_as(
            "POST",
            &format!("/api/v1/tenant/group-invitations/{inv_b1_id}/decline"),
            Value::Null,
            &ops_b_token,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, inv_b2) = h
        .send(
            "POST",
            &format!("/api/platform/groups/{group_id}/invitations"),
            json!({
                "org_id": org_b_uuid,
                "step_up": admin_key.step_up(&h.owner).await,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let inv_b2_id = inv_b2["id"].as_str().unwrap();

    let (status, _) = h
        .send(
            "DELETE",
            &format!("/api/platform/groups/{group_id}/invitations/{inv_b2_id}"),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

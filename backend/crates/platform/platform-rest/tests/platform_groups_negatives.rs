// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "fixtures/group_harness.rs"]
mod group_harness;

use console_kernel_core::OrgId;
use console_platform_rest::PLATFORM_GROUPS_PATH;
use console_platform_test_support::soft_passkey::SoftKey;
use group_harness::{Harness, call, seed_org, seed_user};
use http::{Method, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn group_routes_enforce_negatives_and_account_dto_fields(pool: PgPool) {
    let h = Harness::new(&pool).await;
    let service = h.service();
    let admin = seed_user(&pool, OrgId::platform(), vec!["SUPER_ADMIN".into()]).await;
    let admin_token = h
        .token(admin, OrgId::platform(), true, vec!["SUPER_ADMIN".into()])
        .await;
    let mut key = SoftKey::enroll(&pool, OrgId::platform(), admin).await;

    let unprivileged = seed_user(&pool, OrgId::platform(), vec!["MEMBER".into()]).await;
    let unprivileged_token = h
        .token(unprivileged, OrgId::platform(), true, vec!["MEMBER".into()])
        .await;

    let tenant_active = seed_org(&pool, "active", "ACTIVE").await;
    let tenant_user = seed_user(
        &pool,
        OrgId::from_uuid(tenant_active),
        vec!["SUPER_ADMIN".into()],
    )
    .await;
    let tenant_token = h
        .token(
            tenant_user,
            OrgId::from_uuid(tenant_active),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;

    let (_, g1) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-neg-1","name":"Group One"})),
    )
    .await;
    let (_, g2) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-neg-2","name":"Group Two"})),
    )
    .await;
    let (_, g_susp) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-susp","name":"Suspended"})),
    )
    .await;
    let (_, g_arch) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-arch","name":"Archived"})),
    )
    .await;
    let g1_id = Uuid::parse_str(g1["id"].as_str().unwrap()).unwrap();
    let g2_id = Uuid::parse_str(g2["id"].as_str().unwrap()).unwrap();
    let g_susp_id = Uuid::parse_str(g_susp["id"].as_str().unwrap()).unwrap();
    let g_arch_id = Uuid::parse_str(g_arch["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        call(
            &service,
            Method::PATCH,
            format!("/api/platform/groups/{g_susp_id}"),
            &admin_token,
            Some(json!({"status":"SUSPENDED"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &service,
            Method::PATCH,
            format!("/api/platform/groups/{g_arch_id}"),
            &admin_token,
            Some(json!({"status":"ARCHIVED"}))
        )
        .await
        .0,
        StatusCode::OK
    );

    // Missing passkey on operator without enrolled passkey -> 403 passkey_required.
    let no_passkey = seed_user(&pool, OrgId::platform(), vec!["SUPER_ADMIN".into()]).await;
    let no_passkey_token = h
        .token(
            no_passkey,
            OrgId::platform(),
            true,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let (st, body) = call(
        &service,
        Method::PUT,
        format!("/api/platform/groups/{g1_id}/organizations/{tenant_active}"),
        &no_passkey_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (st, body["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("passkey_required"))
    );

    // Duplicate slug -> 409.
    let (st, _) = call(
        &service,
        Method::POST,
        PLATFORM_GROUPS_PATH.into(),
        &admin_token,
        Some(json!({"slug":"g-neg-1","name":"Dup"})),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);

    // Tenant token -> 403 and unprivileged platform role -> 401 on every group endpoint.
    for (token, expected) in [
        (&tenant_token, StatusCode::FORBIDDEN),
        (&unprivileged_token, StatusCode::UNAUTHORIZED),
    ] {
        for (method, path, payload) in [
            (Method::GET, PLATFORM_GROUPS_PATH.to_owned(), None),
            (
                Method::POST,
                PLATFORM_GROUPS_PATH.to_owned(),
                Some(json!({"slug":"g-deny","name":"Deny"})),
            ),
            (
                Method::GET,
                format!("/api/platform/groups/{g1_id}/accounts"),
                None,
            ),
            (
                Method::PUT,
                format!("/api/platform/groups/{g1_id}/organizations/{tenant_active}"),
                Some(json!({})),
            ),
            (
                Method::POST,
                format!("/api/platform/groups/{g1_id}/accounts"),
                Some(
                    json!({"org_id":tenant_active,"display_name":"X","tenant_roles":["MEMBER"],"group_role":"GROUP_ADMIN"}),
                ),
            ),
            (
                Method::DELETE,
                format!("/api/platform/groups/{g1_id}/accounts/{tenant_user}/roles/GROUP_ADMIN"),
                None,
            ),
        ] {
            let (st, _) = call(&service, method, path, token, payload).await;
            assert_eq!(st, expected);
        }
    }

    // SUSPENDED / ARCHIVED groups reject assign and account creation with 422.
    for blocked_group in [g_susp_id, g_arch_id] {
        let (st, _) = call(
            &service,
            Method::PUT,
            format!("/api/platform/groups/{blocked_group}/organizations/{tenant_active}"),
            &admin_token,
            Some(json!({"step_up": key.step_up(&pool).await})),
        )
        .await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
        let (st, _) = call(&service, Method::POST, format!("/api/platform/groups/{blocked_group}/accounts"), &admin_token, Some(json!({"org_id":tenant_active,"display_name":"Blocked","tenant_roles":["MEMBER"],"group_role":"GROUP_ADMIN","step_up": key.step_up(&pool).await}))).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    }

    // Unknown and platform sentinel IDs -> 404.
    let (st, _) = call(
        &service,
        Method::GET,
        format!("/api/platform/groups/{}/accounts", Uuid::new_v4()),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = call(
        &service,
        Method::PUT,
        format!(
            "/api/platform/groups/{g1_id}/organizations/{}",
            OrgId::platform().as_uuid()
        ),
        &admin_token,
        Some(json!({"step_up": key.step_up(&pool).await})),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Assign tenant_active, create group account, assert DTO exposes person_id & principal_kind, and verify cross-group revoke -> 404.
    assert_eq!(
        call(
            &service,
            Method::PUT,
            format!("/api/platform/groups/{g1_id}/organizations/{tenant_active}"),
            &admin_token,
            Some(json!({"step_up": key.step_up(&pool).await}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (st, acct) = call(&service, Method::POST, format!("/api/platform/groups/{g1_id}/accounts"), &admin_token, Some(json!({"org_id":tenant_active,"display_name":"GroupOp","phone":"groupop@example.com","tenant_roles":["MEMBER"],"group_role":"GROUP_ADMIN","step_up": key.step_up(&pool).await}))).await;
    assert_eq!(st, StatusCode::CREATED, "{acct}");
    let uid = acct["account"]["user_id"].as_str().unwrap().to_owned();

    let (st, listed) = call(
        &service,
        Method::GET,
        format!("/api/platform/groups/{g1_id}/accounts"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{listed}");
    let item = &listed.as_array().unwrap()[0];
    assert!(
        item.get("person_id").is_some(),
        "person_id must be serialized: {item}"
    );
    assert_eq!(item["principal_kind"], "TENANT_PERSON");

    let (st, _) = call(
        &service,
        Method::DELETE,
        format!("/api/platform/groups/{g2_id}/accounts/{uid}/roles/GROUP_ADMIN"),
        &admin_token,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

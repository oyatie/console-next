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
async fn settings_cedar_scope_and_grant_grid(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Settings Co')")
        .bind(org)
        .bind(format!("set-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let keys = keys();
    let admin = seed_user(&pool, org, "SUPER_ADMIN").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());

    let change = json!({"value": 20, "reason_code": "POLICY_REVIEW"});
    let add =
        json!({"domain": "org_change_reject", "label_ko": "테스트 사유", "requires_note": false});
    // (b) Out of scope: user holds grant over legal entity A only.
    // Tenant-wide writes get scope_tenant_wide_only (403), writes targeting
    // entity B get out_of_scope (403), and 0 rows are written.
    let le_a = seed_legal_entity(&pool, org, admin).await;
    let le_b = seed_legal_entity(&pool, org, admin).await;
    let scoped_user = seed_user(&pool, org, "MEMBER").await;
    let scoped_token = token(&pool, &keys, org, scoped_user, "MEMBER").await;
    seed_role_and_grant(&pool, org, admin, scoped_user, "LEGAL_ENTITY", Some(le_a)).await;

    // Tenant-wide settings write (scope_entity_id: None)
    let (status, body) = send(
        &service,
        "POST",
        "/api/v1/settings/auth.idle_timeout_minutes",
        Some(&scoped_token),
        Some(change.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "scope_tenant_wide_only", "{body}");

    // Reason code write (tenant-wide only)
    let (status, body) = send(
        &service,
        "POST",
        "/api/v1/reason-codes",
        Some(&scoped_token),
        Some(add.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "scope_tenant_wide_only", "{body}");

    // Settings write targeting entity B (outside held scope)
    let change_b = json!({
        "value": 20,
        "reason_code": "POLICY_REVIEW",
        "scope_entity_id": le_b,
    });
    let (status, body) = send(
        &service,
        "POST",
        "/api/v1/settings/auth.idle_timeout_minutes",
        Some(&scoped_token),
        Some(change_b),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "out_of_scope", "{body}");

    for sql in [
        "SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1",
        "SELECT count(*) FROM reason_codes WHERE org_id = $1",
    ] {
        let written: i64 = sqlx::query_scalar(sql)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(written, 0, "{sql}");
    }

    // (c) Another tenant: user in org2 attempts to modify settings for entity A in org1.
    // Gets 403 out_of_scope, and 0 rows are written in org1.
    let org2 = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Other Co')")
        .bind(org2)
        .bind(format!("set-{}", &org2.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let other_admin = seed_user(&pool, org2, "SUPER_ADMIN").await;
    let other_user = seed_user(&pool, org2, "MEMBER").await;
    let other_token = token(&pool, &keys, org2, other_user, "MEMBER").await;
    let le_other = seed_legal_entity(&pool, org2, other_admin).await;
    seed_role_and_grant(
        &pool,
        org2,
        other_admin,
        other_user,
        "LEGAL_ENTITY",
        Some(le_other),
    )
    .await;

    let change_foreign = json!({
        "value": 20,
        "reason_code": "POLICY_REVIEW",
        "scope_entity_id": le_a,
    });
    let (status, body) = send(
        &service,
        "POST",
        "/api/v1/settings/auth.idle_timeout_minutes",
        Some(&other_token),
        Some(change_foreign),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "out_of_scope", "{body}");

    for sql in [
        "SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1",
        "SELECT count(*) FROM reason_codes WHERE org_id = $1",
    ] {
        let written: i64 = sqlx::query_scalar(sql)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(written, 0, "{sql}");
    }

    // (d) Granted holder: user with tenant-wide SettingsManage grant in org1 succeeds.
    // Writes succeed with 201 Created and exactly 1 row is written to each table.
    let granted_user = seed_user(&pool, org, "MEMBER").await;
    let granted_token = token(&pool, &keys, org, granted_user, "MEMBER").await;
    seed_role_and_grant(&pool, org, admin, granted_user, "TENANT", None).await;

    let (status, body) = send(
        &service,
        "POST",
        "/api/v1/settings/auth.idle_timeout_minutes",
        Some(&granted_token),
        Some(change),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let (status, body) = send(
        &service,
        "POST",
        "/api/v1/reason-codes",
        Some(&granted_token),
        Some(add),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let overrides_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(overrides_count, 1);

    let reasons_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reason_codes WHERE org_id = $1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reasons_count, 1);
}

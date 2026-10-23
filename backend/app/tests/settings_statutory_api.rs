// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_app::build_router;
use http::StatusCode;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

use console_settings_domain::SettingKey;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settings_and_statutory_answer_signed_in_users_and_writes_stay_closed(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Settings Co')")
        .bind(org)
        .bind(format!("set-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let keys = keys();
    let member = seed_user(&pool, org, "MEMBER").await;
    let admin = seed_user(&pool, org, "SUPER_ADMIN").await;
    let member_token = token(&pool, &keys, org, member, "MEMBER").await;
    let admin_token = token(&pool, &keys, org, admin, "SUPER_ADMIN").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());

    let settings = "/api/v1/settings";
    let codes = "/api/v1/statutory/insurance-loss-codes?insurer=EI&on=2026-10-01";
    let catalog = "/api/v1/reason-codes?domain=org_change_reject";
    for uri in [settings, codes, catalog] {
        let (status, body) = send(&service, "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}: {body}");
    }

    // Every registered key resolves for a plain member, defaults included.
    let (status, page) = send(&service, "GET", settings, Some(&member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), SettingKey::ALL.len(), "{page}");
    assert!(
        page.to_string().contains("auth.idle_timeout_minutes"),
        "{page}"
    );

    // The statutory register: public law, sourced rows, any signed-in user.
    let (status, page) = send(&service, "GET", codes, Some(&member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let rows = page["items"].as_array().unwrap();
    assert!(!rows.is_empty(), "{page}");
    assert!(
        rows.iter()
            .all(|r| r["source_url"].as_str().is_some_and(|u| !u.is_empty()))
    );
    let (status, refused) = send(
        &service,
        "GET",
        "/api/v1/statutory/insurance-loss-codes?insurer=EI",
        Some(&member_token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");

    // The reason catalog lists the system codes for any member.
    let (status, page) = send(&service, "GET", catalog, Some(&member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.to_string().contains("POLICY_VIOLATION"), "{page}");

    // Acceptance-2 DB/API grid:
    // (a) No grant: neither plain member nor legacy SUPER_ADMIN holds settings
    // authority without an explicit grant; all writes and admin reads return 403,
    // and 0 rows are written.
    let change = json!({"value": 20, "reason_code": "POLICY_REVIEW"});
    let history = "/api/v1/settings/auth.idle_timeout_minutes/history";
    let add =
        json!({"domain": "org_change_reject", "label_ko": "테스트 사유", "requires_note": false});
    for token in [&member_token, &admin_token] {
        let calls = [
            (
                "POST",
                "/api/v1/settings/auth.idle_timeout_minutes",
                Some(change.clone()),
            ),
            ("GET", history, None),
            ("POST", "/api/v1/reason-codes", Some(add.clone())),
            ("GET", "/api/v1/reason-codes/stats", None),
        ];
        for (method, uri, body) in calls {
            let (status, body) = send(&service, method, uri, Some(token), body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
            assert_eq!(body["error"]["code"], "forbidden", "{body}");
        }
    }
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
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_ops_without_grants_can_write_settings_and_reason_codes(pool: PgPool) {
    let org = Uuid::new_v4();
    let admin = console_platform_test_support::seed_org_and_super_admin(&pool, org, "ops").await;
    console_platform_test_support::seed_passkey(
        &pool,
        console_kernel_core::OrgId::from_uuid(org),
        admin,
    )
    .await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE org_id = $1 AND id = $2")
        .bind(org)
        .bind(admin.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let keys = keys();
    let token = token(&pool, &keys, org, admin, "SUPER_ADMIN").await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1).unwrap());
    for (uri, body) in [
        (
            "/api/v1/settings/approval.policy.org_structure",
            json!({"value": "route", "reason_code": "POLICY_REVIEW"}),
        ),
        (
            "/api/v1/reason-codes",
            json!({"domain": "org_change_reason", "label_ko": "테스트 조직 개편", "requires_note": false}),
        ),
    ] {
        let (status, body) = send(&service, "POST", uri, Some(&token), Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{uri}: {body}");
    }
    for sql in [
        "SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1",
        "SELECT count(*) FROM reason_codes WHERE org_id = $1",
    ] {
        let count: i64 = sqlx::query_scalar(sql)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "{sql}");
    }
}

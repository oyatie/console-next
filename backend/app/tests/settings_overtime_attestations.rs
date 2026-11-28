// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use http::StatusCode;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_grants_can_only_view_or_record_at_their_granted_scope(pool: PgPool) {
    let org = Uuid::new_v4();
    let admin =
        console_platform_test_support::seed_org_and_super_admin(&pool, org, "overtime-setup").await;
    let entity = seed_legal_entity(&pool, org, admin).await;
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot)
        VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','Assembly','MIGRATION','CREATE',sha256('rule'::bytea),'{}')")
        .bind(org).bind(entity).execute(&pool).await.unwrap();
    let keys = keys();
    let app =
        console_app::build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());
    let path = "/api/v1/settings/overtime-attestations";
    for (domain, can_record, levels) in [
        ("attendance", false, &["view"][..]),
        ("attendance", true, &["view", "approve"][..]),
        ("settings", true, &["view", "edit"][..]),
    ] {
        let user = seed_user(&pool, org, "MEMBER").await;
        seed_grant_with_line(
            &pool,
            org,
            admin,
            user,
            ("LEGAL_ENTITY", Some(entity)),
            (domain, levels),
        )
        .await;
        let jwt = token(&pool, &keys, org, user, "MEMBER").await;
        let (status, access) = send(&app, "GET", "/api/v1/access/me", Some(&jwt), None).await;
        assert_eq!(status, StatusCode::OK, "{access}");
        let scope = &access["entries"][0]["scope"];
        assert_eq!(scope["node_id"], json!(entity));
        assert_eq!(scope["node_name"], json!("Assembly"));
        let (status, setup) = send(
            &app,
            "GET",
            "/api/v1/onboarding/checklist",
            Some(&jwt),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{setup}");
        let step = setup["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == "overtime")
            .unwrap();
        assert_eq!(step["can_act"], json!(can_record), "{step}");
        assert_eq!(step["skippable"], json!(false), "{step}");
        if domain == "settings" {
            assert_eq!(step["needs"], json!("settings::edit"));
        }
        let scoped = format!("{path}?scope_entity_id={entity}");
        let (status, list) = send(&app, "GET", &scoped, Some(&jwt), None).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["can_record"], json!(can_record));
        let command = json!({"scope_entity_id":entity,"confirmed_on":"2026-10-05","rule_reference":"Synthetic work rule","worker_notice_method":"Written notice"});
        assert_eq!(
            send(&app, "POST", path, Some(&jwt), Some(command.clone()))
                .await
                .0,
            if can_record {
                StatusCode::CREATED
            } else {
                StatusCode::FORBIDDEN
            }
        );
        assert_eq!(
            send(&app, "GET", path, Some(&jwt), None).await.0,
            StatusCode::FORBIDDEN
        );
        let mut outside = command;
        outside["scope_entity_id"] = serde_json::Value::Null;
        assert_eq!(
            send(&app, "POST", path, Some(&jwt), Some(outside)).await.0,
            StatusCode::FORBIDDEN
        );
    }
}

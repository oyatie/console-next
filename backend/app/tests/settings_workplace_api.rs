// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_app::build_router;
use http::StatusCode;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (Uuid, axum::Router, String, Uuid, Uuid, (String, String)) {
    let org = Uuid::new_v4();
    let admin = console_platform_test_support::seed_org_and_super_admin(pool, org, "scope").await;
    let manager = seed_user(pool, org, "MEMBER").await;
    seed_role_and_grant(pool, org, admin, manager, "TENANT", None).await;
    let keys = keys();
    let bearer = token(pool, &keys, org, manager, "MEMBER").await;
    let service = build_router(app_state(runtime_pool(pool).await, keys.1.clone()).unwrap());
    let entity = seed_legal_entity(pool, org, admin).await;
    let workplace = Uuid::new_v4();
    sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,needs_confirmation,created_change_mode,created_by) VALUES($1,$2,$3,true,'SETUP',$4)")
        .bind(org).bind(workplace).bind(entity).bind(admin.as_uuid()).execute(pool).await.unwrap();
    (org, service, bearer, entity, workplace, keys)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_explains_four_layers(pool: PgPool) {
    let (_, service, bearer, entity, workplace, _) = fixture(&pool).await;
    let path = "/api/v1/settings/approval.delegation.max_days";
    for (scope, value) in [(None, 25), (Some(entity), 20), (Some(workplace), 10)] {
        let (status, body) = send(
            &service,
            "POST",
            path,
            Some(&bearer),
            Some(json!({
                "scope_entity_id": scope, "value": value, "reason_code": "POLICY_REVIEW"
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let (status, body) = send(
        &service,
        "GET",
        &format!("/api/v1/settings?entity={workplace}"),
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["can_change"], true);
    let entry = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["key"] == "approval.delegation.max_days")
        .unwrap();
    assert_eq!(
        entry["source"],
        json!({"layer": "workplace", "scope_entity_id": workplace})
    );
    let chain = entry["chain"].as_array().unwrap();
    assert_eq!(chain.len(), 4);
    for (item, layer, scope, value, deciding) in [
        (&chain[0], "workplace", Some(workplace), 10, true),
        (&chain[1], "legal_entity", Some(entity), 20, false),
        (&chain[2], "tenant", None, 25, false),
        (&chain[3], "code_default", None, 30, false),
    ] {
        assert_eq!(item["layer"], layer);
        assert_eq!(item["scope_entity_id"], json!(scope));
        assert_eq!(item["value"], value);
        assert_eq!(item["deciding"], deciding);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn orphan_foreign_and_closed_scopes_refuse_in_plan_and_write(pool: PgPool) {
    let (_, service, bearer, entity, _, _) = fixture(&pool).await;
    let (_, _, _, foreign, _, _) = fixture(&pool).await;
    sqlx::query("UPDATE legal_entities SET closed_on=CURRENT_DATE, close_reason_code='BUSINESS_CLOSED' WHERE id=$1")
        .bind(entity)
        .execute(&pool)
        .await
        .unwrap();
    for scope in [Uuid::new_v4(), foreign, entity] {
        for query in ["?dry_run=true", ""] {
            let (status, body) = send(
                &service,
                "POST",
                &format!("/api/v1/settings/approval.delegation.max_days{query}"),
                Some(&bearer),
                Some(json!({
                    "scope_entity_id": scope, "value": 10, "reason_code": "POLICY_REVIEW"
                })),
            )
            .await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
            assert_eq!(body["error"]["code"], "setting_scope_unknown");
            assert_eq!(body["error"]["errors"][0]["field"], "scope_entity_id");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn can_change_preserves_existing_scope_authority(pool: PgPool) {
    let (org, service, _, entity, workplace, keys) = fixture(&pool).await;
    let granter = seed_user(&pool, org, "SUPER_ADMIN").await;
    let manager = seed_user(&pool, org, "MEMBER").await;
    seed_role_and_grant(&pool, org, granter, manager, "LEGAL_ENTITY", Some(entity)).await;
    let bearer = token(&pool, &keys, org, manager, "MEMBER").await;
    for (scope, expected) in [
        (None, false),
        (Some(entity), true),
        (Some(workplace), false),
    ] {
        let query = scope.map_or(String::new(), |id| format!("?entity={id}"));
        let (status, body) = send(
            &service,
            "GET",
            &format!("/api/v1/settings{query}"),
            Some(&bearer),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["can_change"], expected);
    }
}

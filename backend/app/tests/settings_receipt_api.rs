// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod settings_support;

use console_app::build_router;
use console_settings_domain::{SettingKey, SettingKind};
use http::StatusCode;
use serde_json::{Value, json};
use settings_support::*;
use sqlx::PgPool;
use uuid::Uuid;

const RECEIPT_KEY: &str = "onboarding.receipt_days";

async fn fixture(pool: &PgPool) -> (axum::Router, String) {
    let org = Uuid::new_v4();
    console_platform_test_support::seed_org_and_super_admin(pool, org, "receipt").await;
    let member = seed_user(pool, org, "MEMBER").await;
    let keys = keys();
    let bearer = token(pool, &keys, org, member, "MEMBER").await;
    let service = build_router(app_state(runtime_pool(pool).await, keys.1).unwrap());
    (service, bearer)
}

async fn receipt(service: &axum::Router, bearer: &str) -> Value {
    let (status, body) = send(service, "GET", "/api/v1/settings", Some(bearer), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == RECEIPT_KEY)
        .expect("the receipt duration must be served to signed-in members")
        .clone()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_days_serves_the_registry_default_and_definition(pool: PgPool) {
    let (service, bearer) = fixture(&pool).await;
    let entry = receipt(&service, &bearer).await;
    let def = RECEIPT_KEY.parse::<SettingKey>().unwrap().def();
    assert_eq!(entry["kind"], json!(def.kind));
    assert_eq!(entry["default"], json!(def.default));
    assert_eq!(entry["value"], json!(def.default));
    assert_eq!(entry["governance"], json!(def.governance));
    assert_eq!(entry["looser_when"], json!(def.looser_when));
    assert_eq!(entry["version"], "code_default");
    assert_eq!(entry["source"]["layer"], "code_default");
    assert!(entry["effective_from"].is_null());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_days_serves_the_effective_override_including_zero(pool: PgPool) {
    let (service, bearer) = fixture(&pool).await;
    let def = RECEIPT_KEY.parse::<SettingKey>().unwrap().def();
    let default = def.default.unwrap();
    let days = def.ordinal(default).unwrap() + 1;
    sqlx::query("INSERT INTO platform_setting_overrides(key,value,effective_from) VALUES($1,$2,now()+interval '1 day')")
        .bind(RECEIPT_KEY).bind(json!(days + 1)).execute(&pool).await.unwrap();
    for value in [days, 0] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO platform_setting_overrides(key,value) VALUES($1,$2) RETURNING id",
        )
        .bind(RECEIPT_KEY)
        .bind(json!(value))
        .fetch_one(&pool)
        .await
        .unwrap();
        let entry = receipt(&service, &bearer).await;
        // Zero is the off switch; it must never fall back to the nonzero default.
        assert_eq!(entry["value"], value);
        assert_eq!(entry["default"], json!(default));
        assert_eq!(entry["version"], json!({"override": id}));
        assert_eq!(entry["source"]["layer"], "platform");
        assert_eq!(entry["scheduled"][0]["value"], days + 1);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_days_database_refuses_values_outside_the_definition(pool: PgPool) {
    let SettingKind::Int { min, max, .. } = RECEIPT_KEY.parse::<SettingKey>().unwrap().def().kind
    else {
        panic!("receipt duration must be an integer");
    };
    for value in [
        json!(min.unwrap() - 1),
        json!(max.unwrap() + 1),
        json!(1.5),
        json!("7"),
    ] {
        let error = sqlx::query("INSERT INTO platform_setting_overrides(key,value) VALUES($1,$2)")
            .bind(RECEIPT_KEY)
            .bind(value)
            .execute(&pool)
            .await
            .unwrap_err();
        let database = error.as_database_error().unwrap();
        assert_eq!(database.code().as_deref(), Some("23514"));
        assert_eq!(database.message(), "setting_value_invalid");
    }
    let written: i64 =
        sqlx::query_scalar("SELECT count(*) FROM platform_setting_overrides WHERE key=$1")
            .bind(RECEIPT_KEY)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(written, 0);
}

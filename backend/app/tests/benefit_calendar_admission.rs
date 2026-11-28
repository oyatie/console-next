// SPDX-License-Identifier: LicenseRef-Proprietary
#![cfg(all(feature = "workspace", feature = "benefit"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const BENEFITS: &str = "/api/v1/benefit-catalog/items";
const CALENDAR: &str = "/api/v1/collaboration/calendar/events";

async fn visible(ctx: &http::Ctx, feature: &str) -> bool {
    let (status, grants) = ctx.call("GET", "/api/v1/me/authz", None).await;
    assert_eq!(status, StatusCode::OK, "{grants}");
    grants["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["feature"] == feature)
}

async fn enroll(pool: &PgPool, org: Uuid, module: &str, enabled: bool, change_ref: &str) {
    sqlx::query("INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,$2,$3,$4)")
        .bind(org).bind(module).bind(enabled).bind(change_ref).execute(pool).await.unwrap();
}

fn disabled((status, body): (StatusCode, Value)) {
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("module_disabled")),
        "{body}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn enrolled_modules_remain_independent_and_check_current_policy_before_replay(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (other, _) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let caller = http::ctx(&pool, org, admin, &["SUPER_ADMIN"], None).await;
    enroll(&pool, other, "calendar", true, "initial").await;
    enroll(&pool, other, "benefits", true, "initial").await;
    let event = json!({"title":"Personal meeting","scope_type":"PERSONAL","starts_at":"2026-08-15T09:00:00+09:00","ends_at":"2026-08-15T10:00:00+09:00"});
    let benefit = json!({"scope":{"scope_type":"ORG"},"category":"extra","name":"Lunch","costLabel":"Monthly","coverageLabel":"Employees"});
    for (path, body, feature) in [
        (BENEFITS, &benefit, "served_benefit_catalog"),
        (CALENDAR, &event, "served_calendar"),
    ] {
        assert!(!visible(&caller, feature).await);
        disabled(caller.call("GET", path, None).await);
        disabled(caller.call("POST", path, Some(body.clone())).await);
    }

    enroll(&pool, org, "benefits", true, "admitted").await;
    assert!(visible(&caller, "served_benefit_catalog").await);
    assert!(!visible(&caller, "served_calendar").await);
    let (status, item) = caller.call("POST", BENEFITS, Some(benefit.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{item}");
    let benefit_key = caller.key.get();
    let lifecycle = format!(
        "/api/v1/lifecycles/benefit_catalog_item/{}",
        item["id"].as_str().unwrap()
    );
    let (status, record) = caller.call("GET", &lifecycle, None).await;
    assert_eq!(status, StatusCode::OK, "{record}");

    enroll(&pool, org, "calendar", true, "admitted").await;
    assert!(visible(&caller, "served_calendar").await);
    let (status, result) = caller.call("POST", CALENDAR, Some(event.clone())).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let calendar_key = caller.key.get();

    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.benefits.enabled','false',clock_timestamp(),$2,'POLICY_REVIEW')")
        .bind(org).bind(admin.as_uuid()).execute(&pool).await.unwrap();
    assert!(!visible(&caller, "served_benefit_catalog").await);
    assert!(visible(&caller, "served_calendar").await);
    disabled(
        caller
            .send("POST", BENEFITS, Some(benefit), Some(benefit_key))
            .await,
    );
    disabled(caller.call("GET", &lifecycle, None).await);
    for action in ["transition", "hold"] {
        disabled(
            caller
                .call("POST", &format!("{lifecycle}/{action}"), Some(json!({})))
                .await,
        );
    }

    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.calendar.enabled','false',clock_timestamp(),$2,'POLICY_REVIEW')")
        .bind(org).bind(admin.as_uuid()).execute(&pool).await.unwrap();
    disabled(caller.call("GET", CALENDAR, None).await);
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.calendar.enabled','true',clock_timestamp(),$2,'POLICY_REVIEW')")
        .bind(org).bind(admin.as_uuid()).execute(&pool).await.unwrap();
    assert!(visible(&caller, "served_calendar").await);
    enroll(&pool, org, "calendar", false, "withdrawn").await;
    assert!(!visible(&caller, "served_calendar").await);
    disabled(
        caller
            .send("POST", CALENDAR, Some(event), Some(calendar_key))
            .await,
    );
    let (status, profile) = caller.call("GET", "/api/v1/me", None).await;
    assert_eq!(status, StatusCode::OK, "{profile}");
    let (status, polls) = caller
        .call("GET", "/api/v1/collaboration/polls", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{polls}");
    #[cfg(feature = "full")]
    {
        let (status, page) = caller.call("GET", "/api/v1/me/workbench", None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["calendar"]["status"], "denied", "{page}");
        assert_eq!(page["calendar"]["code"], "module_disabled");
        assert_eq!(page["todos"]["status"], "ok");
    }
}

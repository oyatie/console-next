// SPDX-License-Identifier: LicenseRef-Proprietary
//! Dissolve preflight and submit name every remaining live dependency.
use super::fixture::{CHANGES, day, tenant};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_dissolution_with_members_and_children_refuses_both_codes_without_writes(pool: PgPool) {
    let t = tenant(pool).await;
    let unit = t.dept("Parent", t.sites[0]).await;
    let child = t.dept("Child", unit).await;
    let person = t
        .person("On leave", unit, t.workplaces[0], "ON_LEAVE")
        .await;
    let id = t
        .draft(
            "DISSOLVE",
            unit,
            json!([{"op":"DISSOLVE_ORG_UNIT","orgUnitId":unit}]),
            &day(0),
        )
        .await;
    let (status, preview) = t
        .ops
        .call("POST", &format!("{CHANGES}/{id}/preflight"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let blockers = preview["preflight"]["blockers"].as_array().unwrap();
    let (status, refused) = t
        .ops
        .call("POST", &format!("{CHANGES}/{id}/submit"), None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "preflight_blocked");
    let reasons = refused["error"]["reasons"].as_array().unwrap();
    for code in ["ORG_UNIT_ACTIVE_MEMBERS", "ORG_UNIT_ACTIVE_CHILDREN"] {
        assert!(blockers.iter().any(|b| b["code"] == code), "{preview}");
        assert!(reasons.iter().any(|r| r == code), "{refused}");
    }
    assert_eq!(t.request(&id).await["status"], "DRAFT");
    assert_eq!(t.head(unit).await.0, 1);
    assert_eq!(t.head(child).await.1["parent_id"], unit.to_string());
    assert_eq!(t.unit_of(person).await, Some(unit));
    assert!(t.events(person).await.is_empty());
}

// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! The assembled REST router forwards the no-schedule filter and preserves scope counts.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[path = "support/http.rs"]
mod support;
use support::{ctx, employee_body, structure, tenant};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn day_board_rest_filters_a_mixed_group_only_when_requested(pool: PgPool) {
    let (org, owner) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = structure(&admin).await;
    let mut people = Vec::new();
    for number in ["UNSCHEDULED", "SCHEDULED"] {
        let mut body = employee_body(number, &branch, &unit);
        body["hire_date"] = json!("2026-01-02");
        let (status, hired) = admin.call("POST", "/api/v1/employees", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{hired}");
        let person = hired["employee"]["id"].as_str().unwrap().to_owned();
        let (status, bound) = admin.call("POST", "/api/v1/employment-assignments", Some(json!({"employee_id": person, "legal_entity_id": entity, "workplace_id": workplace, "valid_from": "2026-01-02"}))).await;
        assert_eq!(status, StatusCode::CREATED, "{bound}");
        people.push(person);
    }
    let work = json!({"kind": "WORK", "shift": {"start": 540, "end": 1080, "breaks": [{"start": 720, "end": 780}]}});
    let (status, pattern) = admin.call("POST", "/api/v1/attendance/patterns", Some(json!({"name": "Office", "kind": "WEEKLY", "days": [work, work, work, work, work, {"kind": "REST_DAY"}, {"kind": "WEEKLY_HOLIDAY"}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{pattern}");
    let (status, assigned) = admin.call("POST", "/api/v1/attendance/schedule/layers", Some(json!({"targets": [{"scope_kind": "PERSON", "scope_id": people[1]}], "pattern_id": pattern["id"], "effective_from": "2026-01-02", "reason": "STANDARD"}))).await;
    assert!(status.is_success(), "{assigned}");

    for query in ["", "&no_schedule_only=false", "&no_schedule_only=true"] {
        let (status, board) = admin
            .call(
                "GET",
                &format!("/api/v1/attendance/days?date=2026-10-06{query}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{board}");
        assert_eq!(board["ledger"]["people"], 2);
        assert_eq!(board["ledger"]["no_schedule"], 1);
        let groups = board["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        let rows = groups[0]["rows"].as_array().unwrap();
        if query.ends_with("true") {
            assert_eq!(
                rows.len(),
                1,
                "REST no_schedule_only must exclude scheduled people"
            );
            assert_eq!(rows[0]["employee_id"], people[0]);
            assert_eq!(rows[0]["day"]["plan"]["kind"], "NO_SCHEDULE");
            assert_eq!(groups[0]["hidden"], 0);
        } else {
            assert_eq!(
                rows.len(),
                2,
                "omitted or false must retain both issue rows"
            );
        }
    }
}

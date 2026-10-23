// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Real people work reaches the release inbox through its owning product APIs.

#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn product_created_people_work_preserves_sources_permissions_and_resolution(pool: PgPool) {
    let (org, requester_id) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let requester = http::ctx(&pool, org, requester_id, &["SUPER_ADMIN"], None).await;
    let inbox_path = "/api/v1/me/action-inbox?limit=200";
    let (status, initial) = requester.call("GET", inbox_path, None).await;
    assert_eq!(status, StatusCode::OK, "{initial}");
    let reviewer_id = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let reviewer = http::ctx(&pool, org, reviewer_id, &["SUPER_ADMIN"], None).await;
    let nonholder_id = http::add_user(&pool, org, &[]).await;
    let nonholder = http::ctx(&pool, org, nonholder_id, &[], None).await;
    let (_, _, branch, unit) = http::structure(&requester).await;
    let (status, created) = requester
        .call(
            "POST",
            "/api/v1/employees",
            Some(http::employee_body("INBOX-PEOPLE", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let employee = created["employee"]["id"].as_str().unwrap();
    let (status, request) = requester
        .call(
            "POST",
            "/api/v1/change-requests",
            Some(json!({
                "kind":"PROFILE_CORRECTION", "subject_type":"EMPLOYEE", "subject_id":employee,
                "payload":{"changes":{"name":"김확인"}}, "reason_code":"DATA_ENTRY_ERROR",
                "note":"업무함 요청 검증"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{request}");
    assert_eq!(request["status"], "OPEN");
    let request_id = request["id"].as_str().unwrap();
    let (status, native) = reviewer
        .call(
            "GET",
            "/api/v1/statutory/insurance-filings?state=PENDING&limit=200",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{native}");
    let filings: Vec<_> = native["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| task["employee_id"] == employee)
        .collect();
    assert_eq!(filings.len(), 4, "one acquisition per insurer: {native}");
    let (status, page) = reviewer.call("GET", inbox_path, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let items = page["items"].as_array().unwrap();
    let register = items
        .iter()
        .find(|item| item["id"] == format!("hr_register:{employee}"))
        .expect("product-created employee needs register work");
    assert_eq!(register["kind"], "register_review");
    assert_eq!(register["title"], created["employee"]["name"]);
    assert_eq!(register["links"][0]["kind"], "employee");
    assert_eq!(register["links"][0]["id"], employee);
    let correction = items
        .iter()
        .find(|item| item["id"] == format!("hr_request:{request_id}"))
        .expect("the independent reviewer receives the open request");
    assert_eq!(correction["kind"], "hr_request");
    assert_eq!(correction["context"]["request"]["kind"], request["kind"]);
    assert_eq!(
        correction["context"]["request"]["reason_code"],
        request["reason_code"]
    );
    assert_eq!(correction["ref"], "");
    assert_eq!(correction["title"], "");
    assert_eq!(correction["links"][0]["kind"], "change_request");
    assert_eq!(correction["links"][0]["id"], request_id);
    assert_eq!(correction["links"][1]["kind"], "employee");
    assert_eq!(correction["links"][1]["id"], employee);
    let today = console_hr_domain::text::parse_yyyy_mm_dd(&http::today_kst()).unwrap();
    for task in &filings {
        let kind = task["kind"].as_str().unwrap();
        let insurer = task["insurer"].as_str().unwrap();
        let event = task["event_id"].as_str().unwrap();
        let id = format!("insurance_filing_{kind}_{insurer}:{event}");
        let item = items
            .iter()
            .find(|item| item["id"] == id)
            .expect("every native pending filing reaches the shared queue");
        assert_eq!(item["kind"], "insurance_filing");
        assert_eq!(item["title"], task["name"]);
        assert_eq!(item["ref"], "");
        assert_eq!(item["context"]["insurance"]["insurer"], task["insurer"]);
        assert_eq!(item["context"]["insurance"]["kind"], task["kind"]);
        assert_eq!(item["links"][0]["kind"], "statutory");
        assert_eq!(item["links"][0]["id"], event);
        let due = task["due_date"]
            .as_str()
            .expect("seeded register has a deadline");
        assert!(item["due"].as_str().unwrap().starts_with(due));
        let due = console_hr_domain::text::parse_yyyy_mm_dd(due).unwrap();
        assert_eq!(item["days_remaining"], (due - today).whole_days());
    }
    let (status, own) = requester.call("GET", inbox_path, None).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    assert!(
        own["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != format!("hr_request:{request_id}")),
        "the requester never receives their own decision: {own}"
    );
    let (status, refused) = nonholder.call("GET", inbox_path, None).await;
    assert_eq!(status, StatusCode::OK, "{refused}");
    assert!(refused["items"].as_array().unwrap().is_empty(), "{refused}");
    assert_eq!(
        refused["total"], 0,
        "populated sources disclose no denied count"
    );
    let (status, withdrawn) = requester
        .call(
            "POST",
            &format!("/api/v1/change-requests/{request_id}/decide"),
            Some(json!({"decision":"WITHDRAW", "reason_code":"CONFIRMED"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{withdrawn}");
    assert_eq!(withdrawn["status"], "WITHDRAWN");
    let filing = filings.iter().find(|task| task["insurer"] == "EI").unwrap();
    let event = filing["event_id"].as_str().unwrap();
    let kind = filing["kind"].as_str().unwrap();
    let resolved_id = format!("insurance_filing_{kind}_EI:{event}");
    let (status, completed) = reviewer
        .call(
            "POST",
            &format!("/api/v1/statutory/insurance-filings/{event}/{kind}/EI"),
            Some(json!({
                "expected_version":filing["version"], "action":"COMPLETE",
                "completed_on":http::today_kst(), "receipt_number":"inbox-people-ei",
                "applicability_facts":{"monthly_hours":160,"weekly_hours":40,"continuous_months":1,
                    "daily":false,"foreign":false,"director_without_worker_status":false}
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["state"], "DONE");
    let (status, refreshed) = reviewer.call("GET", inbox_path, None).await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert!(
        refreshed["items"].as_array().unwrap().iter().all(|item| {
            item["id"] != format!("hr_request:{request_id}") && item["id"] != resolved_id
        }),
        "resolved product records leave the queue: {refreshed}"
    );
}

// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 완료: what the caller decided, newest first, only while they may still read it.

#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

const DONE: &str = "/api/v1/me/action-inbox/done";

async fn request(ctx: &http::Ctx, employee: &str, name: &str) -> String {
    let (status, body) = ctx
        .call(
            "POST",
            "/api/v1/change-requests",
            Some(json!({
                "kind": "PROFILE_CORRECTION", "subject_type": "EMPLOYEE", "subject_id": employee,
                "payload": {"changes": {"name": name}}, "reason_code": "DATA_ENTRY_ERROR", "note": "완료 검증"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_str().unwrap().to_owned()
}

async fn decide(ctx: &http::Ctx, id: &str, decision: &str) {
    let (status, body) = ctx
        .call(
            "POST",
            &format!("/api/v1/change-requests/{id}/decide"),
            Some(json!({"decision": decision, "reason_code": "CONFIRMED"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_decided_request_moves_to_the_deciders_done_list_newest_first(pool: PgPool) {
    let (org, requester_id) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let requester = http::ctx(&pool, org, requester_id, &["SUPER_ADMIN"], None).await;
    let reviewer_id = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let reviewer = http::ctx(&pool, org, reviewer_id, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, unit) = http::structure(&requester).await;
    let mut employees = Vec::new();
    for n in ["DONE-1", "DONE-2", "DONE-3"] {
        let (status, created) = requester
            .call(
                "POST",
                "/api/v1/employees",
                Some(http::employee_body(n, &branch, &unit)),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        employees.push(created["employee"]["id"].as_str().unwrap().to_owned());
    }
    let (status, empty) = reviewer.call("GET", DONE, None).await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(
        (ids(&empty).len(), empty["next_cursor"].clone()),
        (0, Value::Null)
    );
    let first = request(&requester, &employees[0], "가나다").await;
    let second = request(&requester, &employees[1], "라마바").await;
    let third = request(&requester, &employees[2], "사아자").await;
    let withdrawn = request(&requester, &employees[0], "차카타").await;
    decide(&reviewer, &first, "APPLY").await;
    decide(&reviewer, &second, "DECLINE").await;
    decide(&reviewer, &third, "APPLY").await;
    decide(&requester, &withdrawn, "WITHDRAW").await;

    // Newest first, two per page, and the cursor carries on where the page ended.
    // The names on the page are a personnel read: one access-log row per page.
    let logged = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_events WHERE org_id = $1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let before = logged().await;
    let (status, page) = reviewer.call("GET", &format!("{DONE}?limit=2"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(logged().await, before + 1);
    assert_eq!(
        ids(&page),
        [
            format!("hr_request:{third}"),
            format!("hr_request:{second}")
        ]
    );
    let item = &page["items"][1];
    assert_eq!(
        (item["kind"].as_str(), item["outcome"].as_str()),
        (Some("hr_request"), Some("DECLINED"))
    );
    assert_eq!(
        item["links"][0],
        json!({"kind": "change_request", "id": second})
    );
    assert_eq!(
        item["links"][1],
        json!({"kind": "employee", "id": employees[1]})
    );
    assert!(item["completed_at"].is_string());
    let cursor = page["next_cursor"].as_str().unwrap();
    let (status, rest) = reviewer
        .call("GET", &format!("{DONE}?limit=2&cursor={cursor}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{rest}");
    assert_eq!(ids(&rest), [format!("hr_request:{first}")]);
    assert_eq!(rest["next_cursor"], Value::Null);

    // The requester decided nothing (a withdrawal is not a decision); a person
    // without the HR grant, or who has lost it, sees no names.
    let (_, own) = requester.call("GET", DONE, None).await;
    assert!(ids(&own).is_empty(), "{own}");
    let revoked = http::ctx(&pool, org, reviewer_id, &[], None).await;
    let (status, gone) = revoked.call("GET", DONE, None).await;
    assert_eq!(status, StatusCode::OK, "{gone}");
    assert!(ids(&gone).is_empty(), "{gone}");

    // A cursor from somewhere else is refused; the open list is unchanged.
    for bad in ["abc", "1~nocolon"] {
        let (status, refused) = reviewer
            .call("GET", &format!("{DONE}?cursor={bad}"), None)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    }
    let (_, open) = reviewer
        .call("GET", "/api/v1/me/action-inbox?limit=200", None)
        .await;
    assert!(
        ids(&open).iter().all(|id| !id.starts_with("hr_request:")),
        "{open}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_tenants_decisions_never_appear(pool: PgPool) {
    let (org, requester_id) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let requester = http::ctx(&pool, org, requester_id, &["SUPER_ADMIN"], None).await;
    let reviewer_id = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let reviewer = http::ctx(&pool, org, reviewer_id, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, unit) = http::structure(&requester).await;
    let (_, created) = requester
        .call(
            "POST",
            "/api/v1/employees",
            Some(http::employee_body("DONE-X", &branch, &unit)),
        )
        .await;
    let id = request(
        &requester,
        created["employee"]["id"].as_str().unwrap(),
        "가나다",
    )
    .await;
    decide(&reviewer, &id, "APPLY").await;
    let (other_org, other_id) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let other = http::ctx(&pool, other_org, other_id, &["SUPER_ADMIN"], None).await;
    let (status, page) = other.call("GET", DONE, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(ids(&page).is_empty(), "{page}");
}

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! AX-5 (UX-R3 SCOPE; governance-01, people-self-01, worst-case-08 — the same
//! root three rounds running): a grant's scope is what its holder sees and
//! does. An account with no legacy role, granted 인사 실무 over 법인 A, reads
//! and works every person in A — including one with no 법인/사업장 assignment
//! whose 부서 sits under A's 사업장 — and nobody in B. Outside the scope, or
//! no such person, is one 403 `out_of_scope` with nothing written. A door
//! that acts on the whole tenant answers 403 `scope_tenant_wide_only`. A 부서
//! grant reaches its subtree only (governance-22, people-self-23). Ops is
//! unaffected.
//!
//! regression: on the parent (f7a5212e) the in-scope history read
//! (`GET …/lifecycle-events`) is 403 and the roster shows only the people
//! homed in the projected branch.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/go_live.rs"]
mod go_live;
#[path = "support/refusals.rs"]
mod refusals;
#[path = "support/http.rs"]
mod support;
#[path = "scope_ax5/world.rs"]
mod world;

use refusals::{code, refused};
use support::{Ctx, count, employee_body};
use world::{World, world};

const FORBIDDEN: StatusCode = StatusCode::FORBIDDEN;

async fn roster(ctx: &Ctx) -> (i64, Vec<String>) {
    let (status, page) = ctx.call("GET", "/api/v1/employees?limit=100", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let mut ids: Vec<String> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    (page["total"].as_i64().unwrap(), ids)
}

fn sorted(ids: &[&String]) -> Vec<String> {
    let mut v: Vec<String> = ids.iter().map(|s| (*s).clone()).collect();
    v.sort();
    v
}

/// The person reads a holder may make, by path suffix after `/employees/{id}`.
const READS: [&str; 5] = [
    "",
    "/lifecycle-events",
    "/records",
    "/personal-facts",
    "/employee-number/history",
];

async fn reads_ok(ctx: &Ctx, person: &str) {
    for tail in READS {
        let uri = format!("/api/v1/employees/{person}{tail}");
        let (status, body) = ctx.call("GET", &uri, None).await;
        assert_eq!(status, StatusCode::OK, "GET {uri}: {body}");
    }
}

async fn reads_refused(w: &World, ctx: &Ctx, person: &str) {
    for tail in READS {
        let uri = format!("/api/v1/employees/{person}{tail}");
        refused(&w.pool, ctx, "GET", &uri, None, FORBIDDEN, "out_of_scope").await;
    }
}

fn transfer(to_unit: &str) -> Value {
    json!({
        "event_type": "TRANSFER", "to_org_unit_id": to_unit,
        "effective_date": support::today_kst(), "comment": "범위 시험",
        "signoffs": { "privacy_notice_ack": true, "korean_labor_law_ack": true },
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_legal_entity_grant_reaches_its_people_and_only_them(pool: PgPool) {
    let mut w = world(pool).await;
    let le_a = w.le_a.clone();
    let hr = w.holder("LEGAL_ENTITY", Some(&le_a)).await;

    // The roster is A's people (a2 has no assignment: its 부서 is under A).
    let (total, ids) = roster(&hr).await;
    assert_eq!(
        (total, ids),
        (2, sorted(&[&w.a1, &w.a2])),
        "the scope's people and count"
    );
    reads_ok(&hr, &w.a1).await;
    reads_ok(&hr, &w.a2).await;

    // B's person and a person who does not exist read the same: out_of_scope.
    reads_refused(&w, &hr, &w.b1).await;
    let nobody = Uuid::new_v4().to_string();
    reads_refused(&w, &hr, &nobody).await;
    let (_, b_body) = hr
        .call("GET", &format!("/api/v1/employees/{}", w.b1), None)
        .await;
    let (_, none_body) = hr
        .call("GET", &format!("/api/v1/employees/{nobody}"), None)
        .await;
    assert_eq!(b_body, none_body, "no existence leak");

    // Registration into A, never into B (nothing written).
    let into_a = employee_body("A-101", &w.branch_a, &w.dept_x);
    let (status, made) = hr.call("POST", "/api/v1/employees", Some(into_a)).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let before = count(&w.pool, "employees", w.org).await;
    let into_b = employee_body("B-101", &w.branch_b, &w.dept_b);
    refused(
        &w.pool,
        &hr,
        "POST",
        "/api/v1/employees",
        Some(into_b),
        FORBIDDEN,
        "out_of_scope",
    )
    .await;
    assert_eq!(count(&w.pool, "employees", w.org).await, before);

    // 발령: inside A yes; a B person or a B target, no.
    let a1 = format!("/api/v1/employees/{}/lifecycle-events", w.a1);
    let b1 = format!("/api/v1/employees/{}/lifecycle-events", w.b1);
    refused(
        &w.pool,
        &hr,
        "POST",
        &b1,
        Some(transfer(&w.dept_b)),
        FORBIDDEN,
        "out_of_scope",
    )
    .await;
    refused(
        &w.pool,
        &hr,
        "POST",
        &a1,
        Some(transfer(&w.dept_b)),
        FORBIDDEN,
        "out_of_scope",
    )
    .await;
    let (status, moved) = hr.call("POST", &a1, Some(transfer(&w.dept_y))).await;
    assert_eq!(status, StatusCode::OK, "{moved}");

    // A whole-tenant door says so, typed.
    let unplaced = "/api/v1/employees/import/unplaced";
    refused(
        &w.pool,
        &hr,
        "GET",
        unplaced,
        None,
        FORBIDDEN,
        "scope_tenant_wide_only",
    )
    .await;
    let (_, body) = hr.call("GET", unplaced, None).await;
    assert!(
        body["error"]["refusals"]
            .as_array()
            .is_some_and(|a| !a.is_empty()),
        "names the held scope: {body}"
    );

    // Ops is unaffected.
    let (total, _) = roster(&w.ops).await;
    assert_eq!(total, 4, "ops sees every person");
    reads_ok(&w.ops, &w.b1).await;
    let (status, body) = w
        .ops
        .call("GET", &format!("/api/v1/employees/{nobody}"), None)
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "not_found"),
        "{body}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_department_grant_reaches_its_subtree_only(pool: PgPool) {
    let mut w = world(pool).await;
    let dept = w.dept_x.clone();
    let team = w.holder("DEPARTMENT", Some(&dept)).await;
    let (total, ids) = roster(&team).await;
    assert_eq!((total, ids), (1, sorted(&[&w.a1])), "인사부 only");
    reads_ok(&team, &w.a1).await;
    reads_refused(&w, &team, &w.a2).await;
    reads_refused(&w, &team, &w.b1).await;
    let a1 = format!("/api/v1/employees/{}/lifecycle-events", w.a1);
    refused(
        &w.pool,
        &team,
        "POST",
        &a1,
        Some(transfer(&w.dept_y)),
        FORBIDDEN,
        "out_of_scope",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_grant_reaches_the_people_placed_there(pool: PgPool) {
    let mut w = world(pool).await;
    let (status, a) = w
        .ops
        .call("GET", &format!("/api/v1/employees/{}", w.a1), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{a}");
    let wp: String = sqlx::query_scalar(
        "SELECT workplace_id::text FROM employment_assignments WHERE employee_id = $1::uuid",
    )
    .bind(&w.a1)
    .fetch_one(&w.pool)
    .await
    .unwrap();
    let site = w.holder("WORKPLACE", Some(&wp)).await;
    let (total, ids) = roster(&site).await;
    assert_eq!((total, ids), (2, sorted(&[&w.a1, &w.a2])), "본사's people");
    reads_refused(&w, &site, &w.b1).await;
}

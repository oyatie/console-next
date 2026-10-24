// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! All direct placement routes expose the same opening-date refusal and inclusive boundary.

#[path = "support/http.rs"]
mod support;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{Ctx, address, count, ctx, employee_body, entity_body, tenant};

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const BEFORE: &str = "2021-03-01";
const OPEN: &str = "2021-03-02";

struct Place {
    workplace: String,
    branch: String,
    unit: String,
}

struct World {
    c: Ctx,
    entity: String,
    source: Place,
    target: Place,
}

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

async fn created(c: &Ctx, uri: &str, body: Value) -> Value {
    let (status, body) = c.call("POST", uri, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{uri}: {body}");
    body
}

async fn world(pool: &PgPool) -> World {
    let (org, user) = tenant(pool, ADMIN).await;
    let c = ctx(pool, org, user, ADMIN, None).await;
    let (status, terms) = c.call("GET", "/api/v1/onboarding/terms", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = c
        .call(
            "POST",
            "/api/v1/onboarding/terms",
            Some(json!({ "version": terms["version"], "sha256": terms["sha256"] })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let mut input = entity_body();
    input["incorporated_on"] = json!("2020-03-02");
    let entity = created(&c, "/api/v1/legal-entities", input).await;
    let entity = text(&entity["record"]["id"]);
    let registration = created(
        &c,
        &format!("/api/v1/legal-entities/{entity}/registrations"),
        json!({
            "brn": support::STRUCTURE_BRN, "trade_name": "주식회사 가나", "opened_on": "2020-03-02",
            "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서",
            "tax_type": "01", "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
        }),
    )
    .await;
    let mut places = Vec::new();
    for (name, date) in [("본사", "2020-03-02"), ("공장", OPEN)] {
        let workplace = created(
            &c,
            &format!("/api/v1/legal-entities/{entity}/workplaces"),
            json!({
                "name": name, "registration_id": registration["record"]["id"],
                "same_address_as_registration": true, "opened_on": date,
                "is_head_office": name == "본사", "kind_code": "HEAD_OFFICE",
                "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
            }),
        )
        .await;
        places.push(Place {
            workplace: text(&workplace["record"]["id"]),
            branch: text(&workplace["record"]["default_branch_id"]),
            unit: text(&workplace["record"]["org_unit_id"]),
        });
    }
    let target = places.pop().unwrap();
    let source = places.pop().unwrap();
    World {
        c,
        entity,
        source,
        target,
    }
}

fn employee(w: &World, place: &Place, number: &str, hire: &str) -> Value {
    let mut body = employee_body(number, &place.branch, &place.unit);
    body["hire_date"] = json!(hire);
    body["legal_entity_id"] = json!(w.entity);
    body["workplace_id"] = json!(place.workplace);
    body
}

async fn refused(c: &Ctx, uri: &str, body: Value) {
    let (status, body) = c.call("POST", uri, Some(body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{uri}: {body}");
    assert_eq!(
        body["error"]["code"], "workplace_not_open_on_date",
        "{body}"
    );
}

async fn assignment(c: &Ctx, employee: &str) -> Value {
    let (status, body) = c
        .call(
            "GET",
            &format!("/api/v1/employment-assignments?employee_id={employee}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hiring_before_open_is_422_and_opening_day_registers_the_person(pool: PgPool) {
    let w = world(&pool).await;
    refused(
        &w.c,
        "/api/v1/employees",
        employee(&w, &w.target, "OPEN-HIRE", BEFORE),
    )
    .await;
    for table in [
        "employees",
        "employee_employment_profiles",
        "employment_assignments",
    ] {
        assert_eq!(count(&pool, table, w.c.org).await, 0, "{table}");
    }
    let made = created(
        &w.c,
        "/api/v1/employees",
        employee(&w, &w.target, "OPEN-HIRE", OPEN),
    )
    .await;
    let rows = assignment(&w.c, made["employee"]["id"].as_str().unwrap()).await;
    assert_eq!(rows["items"].as_array().unwrap().len(), 1);
    assert_eq!(rows["items"][0]["valid_from"], OPEN);
    assert_eq!(rows["items"][0]["workplace_id"], w.target.workplace);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_lifecycle_move_before_open_is_422_and_opening_day_moves_the_person(pool: PgPool) {
    let w = world(&pool).await;
    let made = created(
        &w.c,
        "/api/v1/employees",
        employee(&w, &w.source, "OPEN-MOVE", "2020-03-02"),
    )
    .await;
    let person = made["employee"]["id"].as_str().unwrap();
    let event_count = count(&pool, "employee_lifecycle_events", w.c.org).await;
    let uri = format!("/api/v1/employees/{person}/lifecycle-events");
    let body = |date: &str| {
        json!({
            "event_type": "TRANSFER", "to_workplace_id": w.target.workplace,
            "to_org_unit_id": w.target.unit, "effective_date": date,
            "comment": "사업장 개설일 경계 검증",
        })
    };
    refused(&w.c, &uri, body(BEFORE)).await;
    assert_eq!(
        count(&pool, "employee_lifecycle_events", w.c.org).await,
        event_count
    );
    let before = assignment(&w.c, person).await;
    assert_eq!(before["items"].as_array().unwrap().len(), 1);
    assert_eq!(before["items"][0]["workplace_id"], w.source.workplace);
    assert!(before["items"][0]["valid_to"].is_null());
    let (status, event) = w.c.call("POST", &uri, Some(body(OPEN))).await;
    assert_eq!(status, StatusCode::OK, "{event}");
    assert_eq!(event["effective_date"], OPEN);
    let after = assignment(&w.c, person).await;
    let target = after["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["workplace_id"] == w.target.workplace)
        .unwrap();
    assert_eq!(target["valid_from"], OPEN);
    assert_eq!(
        count(&pool, "employee_lifecycle_events", w.c.org).await,
        event_count + 1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn explicit_placement_before_open_is_422_and_opening_day_binds_the_person(pool: PgPool) {
    let w = world(&pool).await;
    let mut body = employee(&w, &w.source, "OPEN-BIND", "2020-03-02");
    for field in [
        "org_unit_id",
        "home_branch_id",
        "legal_entity_id",
        "workplace_id",
    ] {
        body[field] = Value::Null;
    }
    let made = created(&w.c, "/api/v1/employees", body).await;
    let person = made["employee"]["id"].as_str().unwrap();
    let body = |date: &str| {
        json!({
            "employee_id": person, "legal_entity_id": w.entity,
            "workplace_id": w.target.workplace, "valid_from": date,
        })
    };
    refused(&w.c, "/api/v1/employment-assignments", body(BEFORE)).await;
    assert_eq!(count(&pool, "employment_assignments", w.c.org).await, 0);
    let placed = created(&w.c, "/api/v1/employment-assignments", body(OPEN)).await;
    assert_eq!(placed["valid_from"], OPEN);
    assert_eq!(placed["workplace_id"], w.target.workplace);
    assert_eq!(count(&pool, "employment_assignments", w.c.org).await, 1);
}

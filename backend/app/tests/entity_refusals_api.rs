#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Negative suite for 법인 · 사업자등록 · 사업장 · setup 부서 over HTTP (TS-3 and
//! the refusal audit, tools/ci/check-refusal-tests.mjs). Every case asserts
//! the status, stable code, unchanged business records, and durable negative
//! command evidence. A retry resolves to its original refused receipt.

use console_kernel_core::kr::synthetic;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, add_user, address, count, ctx, entity_body, structure, tenant, today_kst};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::refused;

const ADMIN: &[&str] = &["SUPER_ADMIN"];

fn workplace(reg: &str, name: &str) -> Value {
    json!({
        "name": name, "registration_id": reg, "same_address_as_registration": true,
        "opened_on": "2021-01-04", "is_head_office": false, "kind_code": "BRANCH",
        "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
    })
}

async fn registration_of(pool: &PgPool, entity: &str) -> String {
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM business_registrations WHERE legal_entity_id = $1")
            .bind(Uuid::parse_str(entity).unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
    id.to_string()
}

/// TS-3: a 법인 write without `legal_entity_manage` is 403 and writes nothing;
/// without a token it is 401.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_writes_without_legal_entity_manage_are_forbidden_and_write_nothing(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, wp, ..) = structure(&admin).await;
    for roles in [&["ADMIN"][..], &["MEMBER"][..]] {
        let user = add_user(&pool, org, roles).await;
        let ctx = ctx(&pool, org, user, roles, None).await;
        refused(
            &pool,
            &ctx,
            "POST",
            "/api/v1/legal-entities",
            Some(entity_body()),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
        let mut revise = entity_body();
        revise["expected_version"] = json!(1);
        revise["effective_from"] = json!(today_kst());
        revise["reason_code"] = json!("RENAME");
        refused(
            &pool,
            &ctx,
            "PUT",
            &format!("/api/v1/legal-entities/{entity}"),
            Some(revise),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
        refused(
            &pool,
            &ctx,
            "POST",
            &format!("/api/v1/workplaces/{wp}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
    }
    assert_eq!(count(&pool, "legal_entities", org).await, 1);
    let anonymous = Ctx {
        token: "not-a-token".into(),
        ..ctx(&pool, org, owner, ADMIN, None).await
    };
    let (status, _) = anonymous
        .call("POST", "/api/v1/legal-entities", Some(entity_body()))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(count(&pool, "legal_entities", org).await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_cannot_use_another_entitys_registration(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (entity, ..) = structure(&ctx).await;
    let reg = registration_of(&pool, &entity).await;
    // A second 사업자등록 needs the 법인's declared VAT unit mode first.
    let uri = format!("/api/v1/legal-entities/{entity}");
    let (_, read) = ctx.call("GET", &uri, None).await;
    let mut declare = entity_body();
    declare["vat_unit_mode"] = json!("PER_WORKPLACE");
    declare["expected_version"] = read["current"]["version"].clone();
    declare["effective_from"] = json!(today_kst());
    declare["reason_code"] = json!("CORRECTION");
    let (status, declared) = ctx.call("PUT", &uri, Some(declare)).await;
    assert_eq!(status, StatusCode::OK, "{declared}");
    let (status, second_reg) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity}/registrations"), Some(json!({
            "brn": synthetic::brn(81, 4321), "trade_name": "주식회사 가나 물류", "opened_on": "2021-01-04",
            "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서",
            "tax_type": "01",
            "business_types": [{ "is_main": true, "sector": "운수업", "item": "물류" }],
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{second_reg}");
    let second_reg = second_reg["record"]["id"].as_str().unwrap();
    let uri = format!("/api/v1/legal-entities/{entity}/workplaces");
    // A same-named 사업장 is allowed (its backing branch takes a "(2)" suffix), so
    // `workplace_name_taken` is not reachable here; the registration is.
    let (status, twin) = ctx
        .call("POST", &uri, Some(workplace(second_reg, "본사")))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{twin}");
    let before = count(&pool, "workplaces", org).await;
    let mut other = entity_body();
    other["name"] = json!("주식회사 다라");
    other["crn"] = json!("000111-0005671");
    let (status, second) = ctx
        .call("POST", "/api/v1/legal-entities", Some(other))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    let second = second["record"]["id"].as_str().unwrap();
    let foreign = format!("/api/v1/legal-entities/{second}/workplaces");
    refused(
        &pool,
        &ctx,
        "POST",
        &foreign,
        Some(workplace(&reg, "남의등록")),
        StatusCode::UNPROCESSABLE_ENTITY,
        "registration_of_other_entity",
    )
    .await;
    assert_eq!(count(&pool, "workplaces", org).await, before);
}

/// Unknown ids are 404 with the record's own code, never a 500 or an empty 200.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_records_are_not_found_with_their_code(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    structure(&ctx).await;
    let nobody = Uuid::new_v4();
    for (method, uri, body, want) in [
        (
            "GET",
            format!("/api/v1/workplaces/{nobody}/revisions"),
            None,
            "workplace_not_found",
        ),
        (
            "GET",
            format!("/api/v1/business-registrations/{nobody}/revisions"),
            None,
            "registration_not_found",
        ),
        (
            "POST",
            format!("/api/v1/org-structure/batches/{nobody}/undo"),
            None,
            "org_setup_batch_not_found",
        ),
        (
            "POST",
            format!("/api/v1/entity-setup/batches/{nobody}/undo"),
            None,
            "entity_setup_batch_not_found",
        ),
        (
            "PATCH",
            format!("/api/v1/org-structure/units/{nobody}"),
            Some(json!({ "name": "x", "expected_version": 1 })),
            "org_unit_not_found",
        ),
        (
            "GET",
            "/api/v1/ref/lists/no_such_list/codes".to_owned(),
            None,
            "ref_list_not_found",
        ),
    ] {
        refused(&pool, &ctx, method, &uri, body, StatusCode::NOT_FOUND, want).await;
    }
}

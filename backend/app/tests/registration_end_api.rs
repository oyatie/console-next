// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! HTTP regression: an unused certificate can be voided even when its entity is in use.

#[path = "support/http.rs"]
mod support;

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn registration_of(owner: &PgPool, entity: &str) -> String {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM business_registrations WHERE legal_entity_id = $1::uuid",
    )
    .bind(entity)
    .fetch_one(owner)
    .await
    .unwrap()
    .to_string()
}

async fn preview(ctx: &support::Ctx, id: &str) -> serde_json::Value {
    let (status, end) = ctx
        .call(
            "GET",
            &format!("/api/v1/business-registrations/{id}/end-options"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{end}");
    end
}

async fn reader_on_branch(owner: &PgPool, org: Uuid, branch: &str) -> support::Ctx {
    let user = support::add_user(owner, org, &["ADMIN"]).await;
    sqlx::query("INSERT INTO user_branches (org_id, user_id, branch_id) VALUES ($1, $2, $3::uuid)")
        .bind(org)
        .bind(user.as_uuid())
        .bind(branch)
        .execute(owner)
        .await
        .unwrap();
    support::ctx(owner, org, user, &["ADMIN"], None).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_preview_uses_its_own_links_before_void(owner: PgPool) {
    let (org, user) = support::tenant(&owner, &["SUPER_ADMIN"]).await;
    let ctx = support::ctx(&owner, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, _, branch, unit) = support::structure(&ctx).await;
    let (status, employee) = ctx
        .call(
            "POST",
            "/api/v1/employees",
            Some(support::employee_body("REG-1", &branch, &unit)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{employee}");
    let (status, end) = ctx
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{entity}/end-options"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{end}");
    assert_eq!(end["delete"]["refusal"], "record_in_use");
    let uri = format!("/api/v1/legal-entities/{entity}");
    let (status, read) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{read}");
    let mut declare = support::entity_body();
    declare["vat_unit_mode"] = json!("PER_WORKPLACE");
    declare["expected_version"] = read["current"]["version"].clone();
    declare["effective_from"] = json!(support::today_kst());
    declare["reason_code"] = json!("CORRECTION");
    let (status, declared) = ctx.call("PUT", &uri, Some(declare)).await;
    assert_eq!(status, StatusCode::OK, "{declared}");
    let (status, spare) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity}/registrations"),
            Some(json!({
                "brn": "000-81-00071", "opened_on": "2020-03-02",
                "business_address": support::address(), "unit_taxation": false,
                "tax_office_label": "삼성세무서", "tax_type": "01",
                "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "소프트웨어" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{spare}");
    let id = spare["record"]["id"].as_str().unwrap();
    let path = format!("/api/v1/business-registrations/{id}");
    let correction = json!({
        "expected_version": spare["record"]["current"]["version"], "effective_from": "2020-03-02",
        "reason_code": "CORRECTION", "brn": "000-81-00071", "opened_on": "2020-03-02",
        "business_address": support::address(), "unit_taxation": false,
        "tax_office_label": "삼성세무서", "tax_type": "01", "status": "CONTINUING",
        "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "소프트웨어" }],
    });
    let (status, revised) = ctx.call("PUT", &path, Some(correction)).await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    let (status, end) = ctx.call("GET", &format!("{path}/end-options"), None).await;
    assert_eq!(status, StatusCode::OK, "{end}");
    assert_eq!(end["id"], id);
    assert_eq!(end["delete"], json!({ "allowed": true }));
    assert_eq!(end["can_manage"], true);
    assert_eq!(end["revisions"], 2);
    assert_eq!(end["linked_workplaces"], json!([]));
    let used = read["registrations"][0]["id"].as_str().unwrap();
    assert_eq!(preview(&ctx, used).await["revisions"], 1);
    let (status, result) = ctx
        .call(
            "POST",
            &format!("{path}/void"),
            Some(json!({ "reason_code": "DUPLICATE" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{result}");
    let (status, missing) = ctx.call("GET", &format!("{path}/end-options"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["error"]["code"], "registration_not_found");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_preview_refusals_and_missing_scope_execute_over_http(owner: PgPool) {
    let (org, user) = support::tenant(&owner, &["SUPER_ADMIN"]).await;
    let ctx = support::ctx(&owner, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, _) = support::structure(&ctx).await;
    let id = registration_of(&owner, &entity).await;
    let path = format!("/api/v1/business-registrations/{id}");
    let end = preview(&ctx, &id).await;
    assert_eq!(
        end["delete"],
        json!({ "allowed": false, "refusal": "record_in_use" })
    );
    assert_eq!(
        end["linked_workplaces"],
        json!([{ "id": workplace, "name": "본사" }])
    );
    let (status, refused) = ctx
        .call(
            "POST",
            &format!("{path}/void"),
            Some(json!({ "reason_code": "DUPLICATE" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "record_in_use");

    let unlinked: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (org_id, region_id, name) \
         SELECT org_id, region_id, 'Unlinked scope' FROM branches WHERE id = $1::uuid RETURNING id",
    )
    .bind(&branch)
    .fetch_one(&owner)
    .await
    .unwrap();
    let outside = reader_on_branch(&owner, org, &unlinked.to_string()).await;
    let (foreign_org, foreign_user) = support::tenant(&owner, &["SUPER_ADMIN"]).await;
    let foreign = support::ctx(&owner, foreign_org, foreign_user, &["SUPER_ADMIN"], None).await;
    for (reader, target) in [
        (&ctx, Uuid::new_v4().to_string()),
        (&outside, id.clone()),
        (&foreign, id.clone()),
    ] {
        let (status, missing) = reader
            .call(
                "GET",
                &format!("/api/v1/business-registrations/{target}/end-options"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
        assert_eq!(missing["error"]["code"], "registration_not_found");
    }

    sqlx::query("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1")
        .bind(org)
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        preview(&ctx, &id).await["delete"],
        json!({ "allowed": false, "refusal": "phase_not_setup" })
    );
    let (status, refused) = ctx
        .call(
            "POST",
            &format!("{path}/void"),
            Some(json!({ "reason_code": "DUPLICATE" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "phase_not_setup");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_registration_preview_hides_sibling_names_but_keeps_the_blocker(owner: PgPool) {
    let (org, user) = support::tenant(&owner, &["SUPER_ADMIN"]).await;
    let ctx = support::ctx(&owner, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, own, branch, ..) = support::structure(&ctx).await;
    let id = registration_of(&owner, &entity).await;
    let (status, sibling) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity}/workplaces"),
            Some(json!({
                "name": "공장", "registration_id": id, "same_address_as_registration": true,
                "opened_on": "2020-03-02", "is_head_office": false, "kind_code": "BRANCH",
                "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{sibling}");
    let reader = reader_on_branch(&owner, org, &branch).await;
    let end = preview(&reader, &id).await;
    assert_eq!(end["can_manage"], false);
    assert_eq!(
        end["delete"],
        json!({ "allowed": false, "refusal": "record_in_use" })
    );
    assert_eq!(
        end["linked_workplaces"],
        json!([{ "id": own, "name": "본사" }])
    );
    assert_eq!(
        preview(&ctx, &id).await["linked_workplaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // Keep the reader's workplace in scope while only the hidden sibling uses this certificate.
    sqlx::query("UPDATE workplaces SET registration_id = NULL WHERE id = $1::uuid")
        .bind(&own)
        .execute(&owner)
        .await
        .unwrap();

    let end = preview(&reader, &id).await;
    assert_eq!(
        end["delete"],
        json!({ "allowed": false, "refusal": "record_in_use" })
    );
    assert_eq!(end["linked_workplaces"], json!([]));
}

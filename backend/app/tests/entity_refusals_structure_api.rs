#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Negative suite, part two: setup 부서 batches, a voided 법인 and two editors
//! on one 부서 version (split from entity_refusals_api for the file-size
//! ceiling). Same rules: status, stable code, nothing written, a retry still
//! refused.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{add_user, count, ctx, entity_body, structure, tenant, today_kst};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::{code, refused};

const ADMIN: &[&str] = &["SUPER_ADMIN"];

/// Setup 부서 batches: a ref used twice and a unit with two parents are 422
/// naming the op; the batch applies nothing.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_setup_batch_with_a_duplicate_ref_or_two_parents_applies_nothing(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (_, _, _, site) = structure(&ctx).await;
    let units = count(&pool, "org_units", org).await;
    let uri = "/api/v1/org-structure/batches";
    let twice = json!({ "ops": [
        { "op": "CREATE", "ref": "a", "name": "가팀", "parent_org_unit_id": site },
        { "op": "CREATE", "ref": "a", "name": "나팀", "parent_org_unit_id": site },
    ] });
    refused(
        &pool,
        &ctx,
        "POST",
        uri,
        Some(twice),
        StatusCode::UNPROCESSABLE_ENTITY,
        "duplicate_ref",
    )
    .await;
    let two_parents = json!({ "ops": [
        { "op": "CREATE", "ref": "a", "name": "가팀", "parent_org_unit_id": site },
        { "op": "CREATE", "name": "다팀", "parent_ref": "a", "parent_org_unit_id": site },
    ] });
    refused(
        &pool,
        &ctx,
        "POST",
        uri,
        Some(two_parents),
        StatusCode::UNPROCESSABLE_ENTITY,
        "one_parent_required",
    )
    .await;
    assert_eq!(count(&pool, "org_units", org).await, units);
}

/// A voided 법인 refuses revision; the void stays (no un-void by revise).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_voided_entity_refuses_revision(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (status, created) = ctx
        .call("POST", "/api/v1/legal-entities", Some(entity_body()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["record"]["id"].as_str().unwrap();
    let (status, voided) = ctx
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{id}/void"),
            Some(json!({ "reason_code": "MISTAKE" })),
        )
        .await;
    assert!(status.is_success(), "{status} {voided}");
    let mut revise = entity_body();
    revise["name"] = json!("되살리기");
    revise["expected_version"] = json!(1);
    revise["effective_from"] = json!(today_kst());
    revise["reason_code"] = json!("RENAME");
    refused(
        &pool,
        &ctx,
        "PUT",
        &format!("/api/v1/legal-entities/{id}"),
        Some(revise),
        StatusCode::CONFLICT,
        "legal_entity_voided",
    )
    .await;
}

/// Two editors on one 부서 version: exactly one rename wins; the other is 409
/// `stale_revision` with the current version, and changes nothing.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_renames_of_one_unit_version_let_exactly_one_win(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let (_, wp, ..) = structure(&ctx).await;
    let (status, unit) = ctx
        .call(
            "POST",
            "/api/v1/org-structure/units",
            Some(json!({ "kind": "DEPARTMENT", "name": "영업팀", "workplace_id": wp })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{unit}");
    let uri = format!(
        "/api/v1/org-structure/units/{}",
        unit["id"].as_str().unwrap()
    );
    let rename = |name: &str| Some(json!({ "name": name, "expected_version": 1 }));
    let (a, b) = tokio::join!(
        ctx.send("PATCH", &uri, rename("영업1팀"), Some(Uuid::new_v4())),
        ctx.send("PATCH", &uri, rename("영업2팀"), Some(Uuid::new_v4())),
    );
    let mut statuses = [a.0, b.0];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CONFLICT],
        "{} / {}",
        a.1,
        b.1
    );
    let loser = if a.0 == StatusCode::CONFLICT {
        &a.1
    } else {
        &b.1
    };
    assert_eq!(code(loser), "stale_revision", "{loser}");
    assert_eq!(loser["error"]["current_version"], 2);
}

/// The tenant's 법인 order (no parent named) is the tenant manager's: an
/// ADMIN or MEMBER is 403 `forbidden` and nothing is written; the
/// SUPER_ADMIN's same reorder applies (org-sibling-order).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reordering_the_tenants_entities_without_the_tenant_grant_is_forbidden(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, ..) = structure(&admin).await;
    let body = json!({ "children": [entity], "expected_children": [entity] });
    let uri = "/api/v1/org-structure/order";
    for roles in [&["ADMIN"][..], &["MEMBER"][..]] {
        let user = add_user(&pool, org, roles).await;
        let ctx = ctx(&pool, org, user, roles, None).await;
        refused(
            &pool,
            &ctx,
            "PUT",
            uri,
            Some(body.clone()),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
    }
    let (status, saved) = admin.call("PUT", uri, Some(body)).await;
    assert_eq!(
        (status, &saved["children"]),
        (StatusCode::OK, &json!([entity])),
        "{saved}"
    );
}

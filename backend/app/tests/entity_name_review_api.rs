#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 0h: a one-time 법인명 review is settled only by a `legal_entity_manage`
//! holder of its own tenant; a lower grant is 403 and another tenant 404, each
//! without a write. The registration body an N-1 client still sends with a
//! `trade_name` is accepted and the name stays the entity's.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{add_user, audits, ctx, structure, tenant};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::refused;

const ADMIN: &[&str] = &["SUPER_ADMIN"];

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_name_review_is_settled_only_by_its_own_manager(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, ..) = structure(&admin).await;
    let (status, record) = admin
        .call("GET", &format!("/api/v1/legal-entities/{entity}"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        record["registrations"][0]["current"]["trade_name"],
        "주식회사 가나"
    );

    // The old code's own 상호 on the registration, raised by the 20261013153646645 backfill.
    sqlx::query(
        "INSERT INTO business_registration_revisions (org_id, registration_id, version, effective_from, trade_name, opened_on, \
           business_address_id, unit_taxation, tax_office_label, tax_type, status, change_mode, reason_code, actor_id, \
           payload_digest, settings_snapshot, command_id) \
         SELECT org_id, registration_id, version + 1, effective_from, 'NURI', opened_on, business_address_id, unit_taxation, \
           tax_office_label, tax_type, status, change_mode, reason_code, actor_id, payload_digest, settings_snapshot, gen_random_uuid() \
         FROM business_registration_revisions r WHERE r.org_id = $1 AND r.version = 1",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    let raised: i64 = sqlx::query_scalar("SELECT legal_entity_name_review_backfill()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(raised, 1);
    let review: Uuid =
        sqlx::query_scalar("SELECT id FROM legal_entity_name_reviews WHERE org_id = $1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    let uri = format!("/api/v1/legal-entities/{entity}/name-reviews/{review}/settle");

    for roles in [&["ADMIN"][..], &["MEMBER"][..]] {
        let user = add_user(&pool, org, roles).await;
        let lower = ctx(&pool, org, user, roles, None).await;
        refused(
            &pool,
            &lower,
            "POST",
            &uri,
            Some(json!({})),
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
    }
    let (other_org, other_owner) = tenant(&pool, ADMIN).await;
    let other = ctx(&pool, other_org, other_owner, ADMIN, None).await;
    refused(
        &pool,
        &other,
        "POST",
        &uri,
        Some(json!({})),
        StatusCode::NOT_FOUND,
        // Indistinguishable from an unknown review: nothing of the other tenant leaks.
        "name_review_not_found",
    )
    .await;
    let unknown = format!(
        "/api/v1/legal-entities/{entity}/name-reviews/{}/settle",
        Uuid::new_v4()
    );
    refused(
        &pool,
        &admin,
        "POST",
        &unknown,
        Some(json!({})),
        StatusCode::NOT_FOUND,
        "name_review_not_found",
    )
    .await;

    let (status, body) = admin
        .call("GET", &format!("/api/v1/legal-entities/{entity}"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["name_reviews"][0]["registration_name"], "NURI");
    assert!(
        body["identity_problems"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["code"] == "legal_name_review")
    );

    let (status, saved) = admin.call("POST", &uri, Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["record"]["name_reviews"], json!([]));
    assert_eq!(saved["record"]["current"]["name"], "주식회사 가나");
    assert_eq!(
        audits(&pool, org, "legal_entity.name_review.settle").await,
        1
    );
}

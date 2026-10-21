#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 0h: a revision's `reason_code` is a person's; the markers only the server
//! writes (`SystemReason`: the N-1 name copy, the derived VAT unit, the close
//! and reopen copies, …) are refused 422 `reason_code_reserved` on every
//! route a person sends one to, with no write (`refused` checks the records,
//! the receipt and the audit trail). Before the fix a 사업자등록 revision
//! carrying `LEGAL_NAME_DERIVED` was an untyped 500: history hides that
//! marker, so the changed-fields seal could not find the row it had written.

use console_entity_domain::SystemReason;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, address, ctx, entity_body, structure, tenant, today_kst};

#[path = "support/refusals.rs"]
mod refusals;
use refusals::{business_state, refused};

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const RESERVED: &str = "reason_code_reserved";

async fn registration_of(pool: &PgPool, entity: &str) -> String {
    let id: Uuid =
        sqlx::query_scalar("SELECT id FROM business_registrations WHERE legal_entity_id = $1")
            .bind(Uuid::parse_str(entity).unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
    id.to_string()
}

/// The registration `structure` made, revised as a person would.
fn registration_revision(version: &Value, reason: &str) -> Value {
    json!({
        "expected_version": version, "effective_from": today_kst(), "reason_code": reason,
        "status": "CONTINUING", "brn": "000-81-00009", "trade_name": "주식회사 가나", "opened_on": "2020-03-02",
        "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서", "tax_type": "01",
        "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
    })
}

async fn version_of(ctx: &Ctx, uri: &str) -> Value {
    let (status, read) = ctx.call("GET", uri, None).await;
    assert_eq!(status, StatusCode::OK, "{read}");
    read["current"]["version"].clone()
}

async fn registration_version(ctx: &Ctx, entity: &str) -> Value {
    let (status, read) = ctx
        .call("GET", &format!("/api/v1/legal-entities/{entity}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    read["registrations"][0]["current"]["version"].clone()
}

/// Revision rows of the tenant carrying a server marker (the server's own: a
/// registration's create derives the VAT unit), compared before and after.
async fn markers(pool: &PgPool, org: Uuid) -> i64 {
    let markers: Vec<&str> = SystemReason::ALL
        .iter()
        .filter(|s| **s != SystemReason::Create)
        .map(|s| s.as_str())
        .collect();
    sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM legal_entity_revisions WHERE org_id = $1 AND reason_code = ANY($2)) \
              + (SELECT count(*) FROM business_registration_revisions WHERE org_id = $1 AND reason_code = ANY($2)) \
              + (SELECT count(*) FROM workplace_revisions WHERE org_id = $1 AND reason_code = ANY($2)) \
              + (SELECT count(*) FROM workplace_insurance_revisions WHERE org_id = $1 AND reason_code = ANY($2)) \
              + (SELECT count(*) FROM workplace_registration_changes WHERE org_id = $1 AND reason_code = ANY($2))",
    )
    .bind(org)
    .bind(markers)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Regression (fails on dev with a 500): the N-1 name-copy marker on a
/// 사업자등록 revision is refused at the boundary, and the same revision with a
/// person's reason saves.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_registration_revision_carrying_the_name_copy_marker_is_refused(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, ..) = structure(&admin).await;
    let uri = format!(
        "/api/v1/business-registrations/{}",
        registration_of(&pool, &entity).await
    );
    let version = registration_version(&admin, &entity).await;
    let before = markers(&pool, org).await;
    // The reported case first (dev: 500), then every other marker.
    let first = SystemReason::LegalNameDerived;
    for marker in std::iter::once(&first).chain(SystemReason::ALL.iter().filter(|m| **m != first)) {
        refused(
            &pool,
            &admin,
            "PUT",
            &uri,
            Some(registration_revision(&version, marker.as_str())),
            StatusCode::UNPROCESSABLE_ENTITY,
            RESERVED,
        )
        .await;
    }
    assert_eq!(markers(&pool, org).await, before);
    let (status, saved) = admin
        .call("PUT", &uri, Some(registration_revision(&version, "CHANGE")))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(markers(&pool, org).await, before);
}

/// Every other route that records a person's reason (revisions, voids, setup-batch
/// ops) refuses a marker the same way.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_revision_route_refuses_a_server_marker(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, wp, ..) = structure(&admin).await;
    let reg = registration_of(&pool, &entity).await;
    let today = today_kst();
    let (status, branch) = admin
        .call(
            "POST",
            &format!("/api/v1/legal-entities/{entity}/workplaces"),
            Some(json!({
                "name": "지점", "registration_id": reg, "same_address_as_registration": true,
                "opened_on": "2021-01-04", "is_head_office": false, "kind_code": "BRANCH",
                "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{branch}");
    let branch = branch["record"]["id"].as_str().unwrap().to_owned();
    let before = markers(&pool, org).await;

    let entity_uri = format!("/api/v1/legal-entities/{entity}");
    let mut revise = entity_body();
    revise["expected_version"] = version_of(&admin, &entity_uri).await;
    revise["effective_from"] = json!(today);
    revise["reason_code"] = json!(SystemReason::VatUnitDerived.as_str());
    let workplace = json!({ "expected_version": 1, "effective_from": today,
        "reason_code": SystemReason::WorkplaceClosed.as_str(), "name": "본사" });
    let insurance = json!({ "expected_version": 1, "effective_from": today,
        "reason_code": SystemReason::LegalEntityCloseCorrected.as_str(),
        "insurers": [{ "insurer": "NPS", "status": "ESTABLISHED", "mgmt_no": "12345678901", "established_on": "2020-03-02" }] });
    let link = json!({ "registration_id": null, "effective_from": today,
        "reason_code": SystemReason::LegalEntityDissolved.as_str() });
    let void = json!({ "reason_code": SystemReason::SetupUndo.as_str() });
    for (method, uri, body) in [
        ("PUT", entity_uri.clone(), revise.clone()),
        ("PUT", format!("/api/v1/workplaces/{wp}"), workplace),
        (
            "PUT",
            format!("/api/v1/workplaces/{wp}/insurance"),
            insurance,
        ),
        (
            "POST",
            format!("/api/v1/workplaces/{branch}/registration-changes"),
            link,
        ),
        (
            "POST",
            format!("/api/v1/workplaces/{branch}/void"),
            void.clone(),
        ),
        ("POST", format!("{entity_uri}/void"), void.clone()),
        (
            "POST",
            format!("/api/v1/business-registrations/{reg}/void"),
            json!({ "reason_code": SystemReason::LegalNameDerived.as_str() }),
        ),
    ] {
        refused(
            &pool,
            &admin,
            method,
            &uri,
            Some(body),
            StatusCode::UNPROCESSABLE_ENTITY,
            RESERVED,
        )
        .await;
    }

    // The sheet path: a batch-wide and an op-level marker, in the preview and the apply.
    let mut op = revise.clone();
    for k in ["expected_version", "effective_from", "reason_code"] {
        op.as_object_mut().unwrap().remove(k);
    }
    let revise_op = |reason: Option<&str>| {
        json!({ "op": "REVISE_ENTITY", "id": entity, "expected_version": revise["expected_version"],
            "entity": op, "reason_code": reason })
    };
    let revise_workplace = json!({ "op": "REVISE_WORKPLACE", "id": wp, "expected_version": 1,
        // A valid rename: only the marker is wrong.
        "workplace": { "name": "본점", "registration_id": reg, "same_address_as_registration": true,
            "opened_on": "2020-03-02", "status": "CONTINUING" }, "reason_code": SystemReason::LegalEntityBusinessClosed.as_str() });
    for (batch_reason, op) in [
        (
            Some(SystemReason::LegalEntityCloseWithdrawn.as_str()),
            revise_op(None),
        ),
        (
            Some("CHANGE"),
            revise_op(Some(SystemReason::LegalNameDerived.as_str())),
        ),
        (Some("CHANGE"), revise_workplace),
    ] {
        let mut batch = json!({ "dry_run": true, "effective_from": today, "reason_code": batch_reason,
            "ops": [op] });
        let before = business_state(&pool, org).await;
        let (status, preview) = admin
            .call("POST", "/api/v1/entity-setup/batches", Some(batch.clone()))
            .await;
        assert_eq!(status, StatusCode::OK, "{preview}");
        assert_eq!(preview["items"][0]["outcome"], "ERROR", "{preview}");
        assert!(
            preview["items"][0]["error"]["fields"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["field"] == "reason_code" && f["code"] == RESERVED),
            "{preview}"
        );
        assert_eq!(
            business_state(&pool, org).await,
            before,
            "a preview writes nothing"
        );
        batch["dry_run"] = json!(false);
        batch["preview_digest"] = preview["preview_digest"].clone();
        refused(
            &pool,
            &admin,
            "POST",
            "/api/v1/entity-setup/batches",
            Some(batch),
            StatusCode::UNPROCESSABLE_ENTITY,
            RESERVED,
        )
        .await;
    }
    assert_eq!(markers(&pool, org).await, before);
}

/// Settling a 법인명 review by the registration's 상호 is a 법인 revision too.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_name_review_settled_with_a_server_marker_is_refused(pool: PgPool) {
    let (org, owner) = tenant(&pool, ADMIN).await;
    let admin = ctx(&pool, org, owner, ADMIN, None).await;
    let (entity, ..) = structure(&admin).await;
    // The old code's own 상호 on the registration, raised by the name-review backfill.
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
    let mut revision = entity_body();
    revision["name"] = json!("NURI");
    revision["expected_version"] =
        version_of(&admin, &format!("/api/v1/legal-entities/{entity}")).await;
    revision["effective_from"] = json!(today_kst());
    revision["reason_code"] = json!(SystemReason::Create.as_str());
    refused(
        &pool,
        &admin,
        "POST",
        &format!("/api/v1/legal-entities/{entity}/name-reviews/{review}/settle"),
        Some(json!({ "revision": revision })),
        StatusCode::UNPROCESSABLE_ENTITY,
        RESERVED,
    )
    .await;
    let settled: Option<time::OffsetDateTime> =
        sqlx::query_scalar("SELECT settled_at FROM legal_entity_name_reviews WHERE id = $1")
            .bind(review)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(settled, None, "the review stays open");
}

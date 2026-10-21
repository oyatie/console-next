#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 등록증 재발급·정정 through the router: POST
//! /business-registrations/{id}/reissues records the new certificate, the
//! facts it changed (the registration's and the 법인's 대표자) and the
//! evidence as one change; a refusal names its field and writes nothing; no
//! token is 401.

mod period_unlock_support;

#[path = "support/terms.rs"]
mod terms;

use axum::body::{Body, to_bytes};
use console_kernel_core::OrgId;
use console_platform_test_support::soft_passkey::passkey_service;
use http::{Request, StatusCode, header};
use period_unlock_support::{admin_in, router, send};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

fn key() -> String {
    Uuid::new_v4().to_string()
}

async fn upload(service: &axum::Router, token: &str, tag: &str) -> Uuid {
    let b = "reissueboundary";
    let body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nBIZ_REG_CERT\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"사업자등록증.pdf\"\r\n\
         Content-Type: application/pdf\r\n\r\n%PDF-1.7 {tag}\r\n--{b}--\r\n"
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/entity-documents")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={b}"),
        )
        .header("Idempotency-Key", key())
        .body(Body::from(body))
        .unwrap();
    let response = service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let doc: Value = serde_json::from_slice(&bytes).unwrap_or(json!({}));
    assert_eq!(status, StatusCode::CREATED, "{doc}");
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn address(road: &str) -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": road, "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" })
}

fn entity(reps: &[&str]) -> Value {
    json!({
        "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
        "representatives": reps, "crn": "000211-0006241",
        "head_office_address": address("서울특별시 강남구 테헤란로 152"),
    })
}

fn certificate(road: &str, issued: &str) -> Value {
    json!({
        "brn": "000-81-62515", "opened_on": "2020-03-02", "business_address": address(road),
        "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발 및 공급업" }],
        "unit_taxation": false, "tax_office_label": "삼성세무서", "tax_type": "01", "cert_issued_on": issued,
    })
}

async fn revisions(owner: &PgPool, reg: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_revisions WHERE registration_id = $1",
    )
    .bind(reg)
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reissued_certificate_is_one_evidenced_change_through_the_router(owner: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '가나 콘솔')")
        .bind(org)
        .bind(format!("re-{}", &org.simple().to_string()[..12]))
        .execute(&owner)
        .await
        .unwrap();
    let (service, issuer) = router(&owner).await;
    let admin = admin_in(
        &owner,
        &passkey_service(),
        &issuer,
        OrgId::from_uuid(org),
        "운영 관리자",
    )
    .await;
    // The tenant ops account accepts the setup terms (as in entity_ops_correction).
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(admin.id)
        .execute(&owner)
        .await
        .unwrap();
    let (status, _) = send(
        &service,
        "/api/v1/onboarding/terms",
        &admin.token,
        Some(&key()),
        terms::publish(&owner).await,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, e) = send(
        &service,
        "/api/v1/legal-entities",
        &admin.token,
        Some(&key()),
        entity(&["홍길동"]),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{e}");
    let entity_id: Uuid = e["record"]["id"].as_str().unwrap().parse().unwrap();
    let first = upload(&service, &admin.token, "v1").await;
    let mut body = certificate("서울특별시 강남구 테헤란로 152", "2020-03-02");
    body["document_id"] = json!(first);
    let (status, r) = send(
        &service,
        &format!("/api/v1/legal-entities/{entity_id}/registrations"),
        &admin.token,
        Some(&key()),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{r}");
    let reg: Uuid = r["record"]["id"].as_str().unwrap().parse().unwrap();
    let reg_version = r["record"]["current"]["version"].as_i64().unwrap();
    let entity_version: i64 = sqlx::query_scalar(
        "SELECT max(version)::int8 FROM legal_entity_revisions WHERE legal_entity_id = $1",
    )
    .bind(entity_id)
    .fetch_one(&owner)
    .await
    .unwrap();

    let uri = format!("/api/v1/business-registrations/{reg}/reissues");
    let second = upload(&service, &admin.token, "v2").await;
    let mut registration = certificate("부산광역시 해운대구 센텀중앙로 79", "2026-10-02");
    registration["expected_version"] = json!(reg_version);
    registration["status"] = json!("CONTINUING");
    registration["issue_reason_kind"] = json!("CORRECTION");
    let mut changed = entity(&["김대표"]);
    changed["expected_version"] = json!(entity_version);
    let reissue = json!({
        "document_id": second, "reason": "CERT_CHANGE_REPORT", "effective_from": "2026-10-01",
        "registration": registration, "entity": changed,
    });

    // Refusals first: each names its field, and nothing is written.
    let before = revisions(&owner, reg).await;
    let mut bare = reissue.clone();
    bare.as_object_mut().unwrap().remove("document_id");
    let (status, v) = send(&service, &uri, &admin.token, Some(&key()), bare).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(v["error"]["errors"][0]["field"], "document_id", "{v}");
    let (status, _) = send(&service, &uri, "not-a-token", Some(&key()), reissue.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(revisions(&owner, reg).await, before);

    let (status, saved) = send(&service, &uri, &admin.token, Some(&key()), reissue).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        saved["record"]["current"]["business_address"]["road_addr_part1"],
        "부산광역시 해운대구 센텀중앙로 79"
    );
    assert_eq!(saved["record"]["current"]["cert_issued_on"], "2026-10-02");
    let reps: Vec<String> = sqlx::query_scalar(
        "SELECT p.name FROM legal_entity_representatives p JOIN legal_entity_revisions r ON r.id = p.revision_id \
         WHERE r.legal_entity_id = $1 AND r.version = (SELECT max(version) FROM legal_entity_revisions WHERE legal_entity_id = $1)",
    )
    .bind(entity_id)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(reps, ["김대표"]);
    let (linked, superseded): (Option<Uuid>, bool) = sqlx::query_as(
        "SELECT (SELECT evidence_document_id FROM business_registration_revisions WHERE registration_id = $1 ORDER BY version DESC LIMIT 1), \
                (SELECT superseded_at IS NOT NULL FROM entity_documents WHERE id = $2)",
    )
    .bind(reg)
    .bind(first)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!((linked, superseded), (Some(second), true));
}

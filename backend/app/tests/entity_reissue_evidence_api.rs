#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 등록증 evidence on the first entry and on a revision: a certificate named as a
//! registration's evidence is checked before anything is written.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/http.rs"]
mod support;
use support::{Ctx, add_user, address, ctx, entity_body, tenant};

const ADMIN: &[&str] = &["SUPER_ADMIN"];

async fn upload(c: &Ctx, kind: &str, tag: &str) -> Uuid {
    let b = "evidenceboundary";
    let body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n{kind}\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc-{tag}.pdf\"\r\n\
         Content-Type: application/pdf\r\n\r\n%PDF-1.7 {tag}\r\n--{b}--\r\n"
    );
    let (status, doc) = c
        .raw(
            "POST",
            "/api/v1/entity-documents",
            &format!("multipart/form-data; boundary={b}"),
            Some(body.into_bytes()),
            Some(Uuid::new_v4()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{doc}");
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn registration(doc: Option<Uuid>) -> Value {
    let mut v = json!({
        "brn": "000-81-62515", "opened_on": "2020-03-02", "business_address": address(),
        "unit_taxation": false, "tax_office_label": "삼성세무서", "tax_type": "01", "cert_issued_on": "2020-03-02",
        "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
    });
    if let Some(d) = doc {
        v["document_id"] = json!(d);
    }
    v
}

async fn setup(pool: &PgPool) -> (Ctx, String, Uuid) {
    let (org, owner) = tenant(pool, ADMIN).await;
    let c = ctx(pool, org, owner, ADMIN, None).await;
    let (_, terms) = c.call("GET", "/api/v1/onboarding/terms", None).await;
    let (status, _) = c
        .call(
            "POST",
            "/api/v1/onboarding/terms",
            Some(json!({ "version": terms["version"], "sha256": terms["sha256"] })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // Production shape: the original kept when the 법인 was created, no registration yet.
    let kept = upload(&c, "BIZ_REG_CERT", "kept").await;
    let mut body = entity_body();
    body["document_id"] = json!(kept);
    let (status, e) = c.call("POST", "/api/v1/legal-entities", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{e}");
    (c, e["record"]["id"].as_str().unwrap().to_owned(), kept)
}

async fn regs(pool: &PgPool, entity: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM business_registrations WHERE legal_entity_id = $1")
        .bind(Uuid::parse_str(entity).unwrap())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn reg_revisions(pool: &PgPool, reg: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_revisions WHERE registration_id = $1",
    )
    .bind(Uuid::parse_str(reg).unwrap())
    .fetch_one(pool)
    .await
    .unwrap()
}

fn issue(v: &Value) -> (String, String) {
    let e = &v["error"]["errors"][0];
    (
        e["field"].as_str().unwrap_or("").into(),
        e["code"].as_str().unwrap_or("").into(),
    )
}

/// Fails on dev: dev creates the registration (201) and parks the registry
/// extract on the 법인, so the certificate record has no evidence.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_registry_extract_is_no_certificate_and_nothing_is_created(pool: PgPool) {
    let (c, entity, _) = setup(&pool).await;
    let extract = upload(&c, "CORP_REGISTRY_EXTRACT", "x").await;
    let uri = format!("/api/v1/legal-entities/{entity}/registrations");
    let (status, v) = c
        .call("POST", &uri, Some(registration(Some(extract))))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(
        issue(&v),
        ("document_id".into(), "document_not_certificate".into())
    );
    assert_eq!(regs(&pool, &entity).await, 0, "a refusal created nothing");
}

/// The first entry reuses the original already attached to the 법인 (passes
/// on both); then a plain revise naming the certificate in force is refused
/// (fails on dev: dev records a revision "evidenced" by the old original).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn first_entry_reuses_the_kept_original_and_a_revise_needs_a_new_one(pool: PgPool) {
    let (c, entity, kept) = setup(&pool).await;
    let uri = format!("/api/v1/legal-entities/{entity}/registrations");
    let (status, r) = c.call("POST", &uri, Some(registration(Some(kept)))).await;
    assert_eq!(status, StatusCode::CREATED, "{r}");
    let reg = r["record"]["id"].as_str().unwrap().to_owned();
    let (docs, linked): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE registration_id = $2 AND superseded_at IS NULL) \
         FROM entity_documents WHERE legal_entity_id = $1",
    )
    .bind(Uuid::parse_str(&entity).unwrap())
    .bind(Uuid::parse_str(&reg).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (docs, linked),
        (1, 1),
        "one document, the kept original, now backs the registration"
    );

    let before = reg_revisions(&pool, &reg).await;
    let mut put = registration(Some(kept));
    put["expected_version"] = r["record"]["current"]["version"].clone();
    put["effective_from"] = json!("2020-03-02");
    put["reason_code"] = json!("COR");
    put["status"] = json!("CONTINUING");
    let (status, v) = c
        .call(
            "PUT",
            &format!("/api/v1/business-registrations/{reg}"),
            Some(put),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    assert_eq!(issue(&v), ("document_id".into(), "document_not_new".into()));
    assert_eq!(
        reg_revisions(&pool, &reg).await,
        before,
        "the refusal wrote no revision"
    );
}

/// The reissue route's Cedar guard: without legal_entity_manage it is 403 and
/// writes nothing (no test in the unit asserts it).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reissue_without_legal_entity_manage_is_forbidden(pool: PgPool) {
    let (c, entity, kept) = setup(&pool).await;
    let uri = format!("/api/v1/legal-entities/{entity}/registrations");
    let (status, r) = c.call("POST", &uri, Some(registration(Some(kept)))).await;
    assert_eq!(status, StatusCode::CREATED, "{r}");
    let reg = r["record"]["id"].as_str().unwrap().to_owned();
    let second = upload(&c, "BIZ_REG_CERT", "v2").await;
    let mut registration = registration(None);
    registration["expected_version"] = r["record"]["current"]["version"].clone();
    registration["status"] = json!("CONTINUING");
    registration["cert_issued_on"] = json!("2026-10-02");
    let body = json!({
        "document_id": second, "reason": "CERT_CHANGE_REPORT", "effective_from": "2026-10-01",
        "registration": registration,
    });
    let before = reg_revisions(&pool, &reg).await;
    for roles in [&["ADMIN"][..], &["MEMBER"][..]] {
        let user = add_user(&pool, c.org, roles).await;
        let other = ctx(&pool, c.org, user, roles, None).await;
        let (status, v) = other
            .call(
                "POST",
                &format!("/api/v1/business-registrations/{reg}/reissues"),
                Some(body.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{roles:?} {v}");
    }
    assert_eq!(reg_revisions(&pool, &reg).await, before);
    // The manager may (the same body, so the guard above is the only difference).
    let (status, v) = c
        .call(
            "POST",
            &format!("/api/v1/business-registrations/{reg}/reissues"),
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(reg_revisions(&pool, &reg).await, before + 1);
}

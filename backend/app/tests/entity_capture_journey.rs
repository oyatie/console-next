#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-CAPTURE through the real router as `console_rt`: reference lists, the
//! address proxies with no juso key (UNAVAILABLE, never an error), a
//! certificate kept from upload to read-back, dated history, the 4대보험
//! change and the 상시근로자수 HOLD placeholder.

#[path = "support/terms.rs"]
mod terms;

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{HeaderMap, Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";
const BOUNDARY: &str = "entcapboundary";
const PDF: &[u8] = b"%PDF-1.7 certificate";

struct Ctx {
    service: axum::Router,
    token: String,
}

impl Ctx {
    async fn raw(
        &self,
        method: &str,
        uri: &str,
        content_type: &str,
        body: Vec<u8>,
        keyed: bool,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, content_type);
        if keyed {
            builder = builder.header("Idempotency-Key", Uuid::new_v4().to_string());
        }
        let response = self
            .service
            .clone()
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        (
            status,
            headers,
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
    }

    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let bytes = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
        let (status, _, out) = self.raw(method, uri, "application/json", bytes, true).await;
        (
            status,
            serde_json::from_slice(&out).unwrap_or_else(|_| json!({})),
        )
    }

    async fn upload(&self, kind: &str, file_name: &str, bytes: &[u8]) -> (StatusCode, Value) {
        let mut body = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/pdf\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n{kind}\r\n--{BOUNDARY}--\r\n").as_bytes());
        let ct = format!("multipart/form-data; boundary={BOUNDARY}");
        let (status, _, out) = self
            .raw("POST", "/api/v1/entity-documents", &ct, body, false)
            .await;
        (
            status,
            serde_json::from_slice(&out).unwrap_or_else(|_| json!({})),
        )
    }
}

fn address() -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
            "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_certificate_is_typed_kept_and_read_back_with_reference_data(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '가나 콘솔')")
        .bind(org)
        .bind(format!("ec-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let admin = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active, is_tenant_ops) VALUES ($1, '대표', $2, $3, true, true)")
        .bind(*admin.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let keys = keys();
    let ctx = Ctx {
        service: build_router(app_state(
            role_pool(&pool, "console_rt").await,
            role_pool(&pool, "console_leave_cmd").await,
            &keys,
        )),
        token: token(&pool, &keys, org, admin).await,
    };

    let (status, _) = ctx
        .call(
            "POST",
            "/api/v1/onboarding/terms",
            Some(terms::publish(&pool).await),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Reference lists: loaded with their source, or honestly not loaded.
    let (status, page) = ctx
        .call(
            "GET",
            "/api/v1/ref/lists/admin_region/codes?q=%EB%B6%84%EB%8B%B9",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        (
            page["list"]["status"].as_str(),
            page["items"][0]["label"].as_str()
        ),
        (Some("LOADED"), Some("성남시 분당구"))
    );
    assert!(page["list"]["source"]["sha256"].is_string());
    let (_, held) = ctx.call("GET", "/api/v1/ref/lists/ksic/codes", None).await;
    assert_eq!(
        (
            held["list"]["status"].as_str(),
            held["items"].as_array().map(Vec::len)
        ),
        (Some("HOLD"), Some(0))
    );
    assert_eq!(
        ctx.call("GET", "/api/v1/ref/lists/nope/codes", None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // No juso key configured: UNAVAILABLE (200), the form falls back to manual entry.
    let (status, hits) = ctx
        .call(
            "GET",
            "/api/v1/ref/address-search?q=%ED%8C%90%EA%B5%90%EC%97%AD%EB%A1%9C",
            None,
        )
        .await;
    assert_eq!(
        (status, hits["status"].as_str()),
        (StatusCode::OK, Some("UNAVAILABLE")),
        "{hits}"
    );
    let (status, _) = ctx.call("GET", "/api/v1/ref/address-search?q=", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let detail = "/api/v1/ref/address-detail?adm_cd=1171010700&rn_mgt_sn=117102005011&udrt_yn=false&buld_mnnm=345&buld_slno=0";
    assert_eq!(
        ctx.call("GET", detail, None).await.1["status"],
        "UNAVAILABLE"
    );

    // Upload: typed by its bytes, no extraction, the same file is the same document.
    let (status, bad) = ctx.upload("BIZ_REG_CERT", "x.pdf", b"MZ not a pdf").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(bad["error"]["errors"][0]["code"], "file_type_not_accepted");
    let (status, doc) = ctx.upload("BIZ_REG_CERT", "사업자등록증.pdf", PDF).await;
    assert_eq!(status, StatusCode::CREATED, "{doc}");
    assert_eq!(
        (
            doc["extraction_status"].as_str(),
            doc["retain_until"].is_null()
        ),
        (Some("NONE"), true)
    );
    let doc_id = doc["id"].as_str().unwrap().to_owned();
    assert_eq!(
        ctx.upload("BIZ_REG_CERT", "again.pdf", PDF).await.1["id"],
        doc["id"]
    );

    // Typed entry with the original attached.
    let (status, entity) = ctx
        .call("POST", "/api/v1/legal-entities", Some(json!({
            "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
            "representatives": ["홍길동"], "crn": "000211-0006241", "head_office_address": address(), "document_id": doc_id,
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity_id = entity["record"]["id"].as_str().unwrap().to_owned();
    assert_eq!(entity["record"]["regular_workers"]["status"], "HOLD");
    let (status, reg) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity_id}/registrations"), Some(json!({
            "brn": "000-81-00009", "trade_name": "주식회사 가나", "opened_on": "2020-03-02", "cert_issued_on": "2024-05-02",
            "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서", "tax_type": "01",
            "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }], "document_id": doc_id,
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    assert_eq!(
        reg["record"]["unverified_reason"], "NOT_CHECKED",
        "진위 확인: 하지 않음, never a fake verified state"
    );
    let (_, docs) = ctx
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{entity_id}/documents"),
            None,
        )
        .await;
    assert_eq!(
        docs["items"][0]["registration_id"], reg["record"]["id"],
        "{docs}"
    );
    assert_eq!(docs["items"][0]["issued_on"], "2024-05-02");

    // The original reads back as uploaded, never cached.
    let (status, headers, bytes) = ctx
        .raw(
            "GET",
            &format!("/api/v1/entity-documents/{doc_id}/content"),
            "application/json",
            vec![],
            false,
        )
        .await;
    assert_eq!((status, bytes.as_slice()), (StatusCode::OK, PDF));
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(headers[header::CONTENT_TYPE], "application/pdf");

    // A 재발급 certificate supersedes the kept one; its retention runs from then
    // (retention.entity_registration_document, 5 years by default). A body over
    // the global 2 MiB JSON limit is still accepted on the upload route.
    let mut reissued = b"%PDF-1.7 reissued ".to_vec();
    reissued.resize(3 * 1024 * 1024, b' ');
    let (status, second) = ctx.upload("BIZ_REG_CERT", "재발급.pdf", &reissued).await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    let version = reg["record"]["current"]["version"].as_i64().unwrap();
    let (status, revised) = ctx
        .call("PUT", &format!("/api/v1/business-registrations/{}", reg["record"]["id"].as_str().unwrap()), Some(json!({
            "expected_version": version, "effective_from": "2026-10-05", "reason_code": "CERTIFICATE_REISSUED",
            "status": "CONTINUING", "brn": "000-81-00009", "trade_name": "주식회사 가나", "opened_on": "2020-03-02",
            "cert_issued_on": "2026-10-01", "business_address": address(), "unit_taxation": false,
            "tax_office_label": "삼성세무서", "tax_type": "01",
            "business_types": [{ "is_main": true, "sector": "정보통신업", "item": "응용 소프트웨어 개발" }],
            "document_id": second["id"],
        })))
        .await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    let (_, docs) = ctx
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{entity_id}/documents"),
            None,
        )
        .await;
    let items = docs["items"].as_array().unwrap();
    let first = items.iter().find(|d| d["id"] == doc["id"]).unwrap();
    let newer = items.iter().find(|d| d["id"] == second["id"]).unwrap();
    let superseded = first["superseded_at"].as_str().unwrap();
    let kst = OffsetDateTime::parse(superseded, &time::format_description::well_known::Rfc3339)
        .unwrap()
        .to_offset(time::UtcOffset::from_hms(9, 0, 0).unwrap())
        .date();
    let expected = kst.replace_year(kst.year() + 5).unwrap().to_string();
    assert_eq!(
        first["retain_until"].as_str(),
        Some(expected.as_str()),
        "{docs}"
    );
    assert!(newer["retain_until"].is_null() && newer["superseded_at"].is_null());
    assert_eq!(newer["issued_on"], "2026-10-01");
    let reg_id = reg["record"]["id"].as_str().unwrap();
    let (status, history) = ctx
        .call(
            "GET",
            &format!("/api/v1/business-registrations/{reg_id}/revisions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let newest = &history["items"][0];
    assert!(
        newest["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["field"] == "cert_issued_on"),
        "{history}"
    );
    assert!(history["items"].as_array().unwrap().iter().any(|r| {
        r["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["field"] == "business_types")
    }));

    // 4대보험 change: keyed, versioned, in the 사업장 history.
    let (status, wp) = ctx
        .call("POST", &format!("/api/v1/legal-entities/{entity_id}/workplaces"), Some(json!({
            "name": "본사", "registration_id": reg["record"]["id"], "same_address_as_registration": true,
            "opened_on": "2020-03-02", "is_head_office": true, "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{wp}");
    assert_eq!(wp["record"]["regular_workers"]["value"], Value::Null);
    let wp_id = wp["record"]["id"].as_str().unwrap().to_owned();
    let change = json!({ "expected_version": 1, "effective_from": "2026-11-01", "reason_code": "INSURANCE_ESTABLISHED",
        "insurers": [{ "insurer": "NPS", "status": "ESTABLISHED", "mgmt_no": "12345678901", "established_on": "2020-03-02" }] });
    let body = change.to_string().into_bytes();
    let (status, _, _) = ctx
        .raw(
            "PUT",
            &format!("/api/v1/workplaces/{wp_id}/insurance"),
            "application/json",
            body,
            false,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "keyless writes are refused"
    );
    let (status, saved) = ctx
        .call(
            "PUT",
            &format!("/api/v1/workplaces/{wp_id}/insurance"),
            Some(change),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (_, history) = ctx
        .call(
            "GET",
            &format!("/api/v1/workplaces/{wp_id}/revisions"),
            None,
        )
        .await;
    assert!(
        history["items"][0]["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["field"] == "insurance.NPS.status"),
        "{history}"
    );
    let (status, history) = ctx
        .call(
            "GET",
            &format!("/api/v1/legal-entities/{entity_id}/revisions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!history["items"].as_array().unwrap().is_empty());
}

fn keys() -> (String, String) {
    let key = SigningKey::random(&mut OsRng);
    (
        key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
}

async fn token(pool: &PgPool, keys: &(String, String), org: Uuid, user: UserId) -> String {
    let settings = JwtSettings {
        issuer: ISSUER.to_owned(),
        audience: AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    };
    let issuer = JwtIssuer::from_es256_pem(settings, keys.0.as_bytes(), keys.1.as_bytes()).unwrap();
    let input = AccessTokenInput {
        subject: user,
        org_id: OrgId::from_uuid(org),
        roles: vec!["SUPER_ADMIN".to_owned()],
        branches: Vec::new(),
        platform: false,
        support: None,
        read_only: false,
        display_name: None,
        feature_grants: Vec::new(),
        authz_subject_version: 0,
        authz_policy_version: 0,
        session_generation: 0,
        issued_at: OffsetDateTime::now_utc(),
    };
    console_platform_test_support::issue_session_token(pool, &issuer, input, None, vec![]).await
}

async fn role_pool(owner: &PgPool, role: &'static str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                let statement = if role == "console_rt" {
                    "SET ROLE console_rt"
                } else {
                    "SET ROLE console_leave_cmd"
                };
                sqlx::query(statement).execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

fn app_state(runtime: PgPool, leave_command: PgPool, keys: &(String, String)) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", keys.0.clone()),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".to_owned(),
        ),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .map(|state| state.with_leave_command_database(leave_command))
        .unwrap()
}

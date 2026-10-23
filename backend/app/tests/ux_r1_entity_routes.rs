#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R1 ENTITY through the real router as `console_rt`: the reader's verbs
//! (can_manage), 설립 중, 휴업's expected end and the close correction, each
//! refusal with its status and code and nothing written.

use axum::body::{Body, to_bytes};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{Request, StatusCode, header};
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

struct Ctx {
    service: axum::Router,
    token: String,
}

impl Ctx {
    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", Uuid::new_v4().to_string())
            .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
        let response = self.service.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        )
    }
}

fn address() -> Value {
    json!({ "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
            "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" })
}

fn corporation(name: &str, crn: Option<&str>, founding: bool) -> Value {
    json!({ "biz_kind": "CORPORATION", "name": name, "representation_mode": "SINGLE",
            "representatives": ["홍길동"], "crn": crn, "head_office_address": address(), "founding": founding })
}

async fn audits(pool: &PgPool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn ctx(pool: &PgPool) -> Ctx {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '가나 콘솔')")
        .bind(org)
        .bind(format!("ux-{}", &org.simple().to_string()[..12]))
        .execute(pool)
        .await
        .unwrap();
    let admin = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, '대표', $2, $3, true)")
        .bind(*admin.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    let keys = keys();
    Ctx {
        service: build_router(app_state(
            role_pool(pool, "console_rt").await,
            role_pool(pool, "console_leave_cmd").await,
            &keys,
        )),
        token: token(pool, &keys, org, admin).await,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn founding_and_reader_verbs_over_http(pool: PgPool) {
    let c = ctx(&pool).await;
    // A 법인 needs its number unless it is being founded; 설립 중 is a 법인's state only.
    let (status, body) = c
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(corporation("주식회사 다라", None, false)),
        )
        .await;
    assert_eq!(
        (status, body["error"]["errors"][0]["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("required"))
    );
    let mut individual = corporation("가나상회", None, true);
    individual["biz_kind"] = json!("INDIVIDUAL");
    let (status, body) = c
        .call("POST", "/api/v1/legal-entities", Some(individual))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["errors"][0]["field"], "founding");
    assert_eq!(
        audits(&pool, "legal_entity.create").await,
        0,
        "refusals write nothing"
    );

    let (status, saved) = c
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(corporation("주식회사 가나", None, true)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let id = saved["record"]["id"].as_str().unwrap().to_owned();
    let (status, e) = c
        .call("GET", &format!("/api/v1/legal-entities/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (e["founding"].as_bool(), e["can_manage"].as_bool()),
        (Some(true), Some(true))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_close_is_corrected_over_http_and_refused_where_it_must_be(pool: PgPool) {
    let c = ctx(&pool).await;
    let (_, saved) = c
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(corporation("주식회사 가나", Some("000211-0006241"), false)),
        )
        .await;
    let id = saved["record"]["id"].as_str().unwrap().to_owned();
    let uri = format!("/api/v1/legal-entities/{id}/close");
    let fix = |on: &str, why: &str| json!({ "closed_on": on, "reason_code": "BUSINESS_CLOSED", "why": why });

    let (status, body) = c.call("PUT", &uri, Some(fix("2026-01-15", "오기"))).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("legal_entity_not_closed"))
    );
    let (status, _) = c
        .call(
            "POST",
            &uri,
            Some(json!({ "closed_on": "2026-01-31", "reason_code": "DISSOLVED" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = c.call("PUT", &uri, Some(fix("2026-01-15", ""))).await;
    assert_eq!(
        (status, body["error"]["errors"][0]["field"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("why"))
    );
    assert_eq!(audits(&pool, "legal_entity.close_correct").await, 0);

    let (status, body) = c
        .call("PUT", &uri, Some(fix("2026-01-15", "폐업일을 잘못 적음")))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            body["record"]["closed_on"].as_str(),
            body["record"]["close_reason_code"].as_str()
        ),
        (Some("2026-01-15"), Some("BUSINESS_CLOSED"))
    );
    assert_eq!(audits(&pool, "legal_entity.close_correct").await, 1);
    // A closed 법인 is read-only for every other write.
    let (status, body) = c.call("PUT", &format!("/api/v1/legal-entities/{id}"), Some(json!({ "expected_version": 1, "effective_from": "2026-01-01", "reason_code": "X", "biz_kind": "CORPORATION", "name": "새이름", "representation_mode": "SINGLE", "representatives": ["홍길동"], "crn": "0002110006241", "head_office_address": address() }))).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("legal_entity_not_open"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_close_is_withdrawn_over_http_and_refused_where_it_must_be(pool: PgPool) {
    // regression: r3 company-15 — 종료 취소 did not exist (the DELETE was 405).
    let c = ctx(&pool).await;
    let (_, saved) = c
        .call(
            "POST",
            "/api/v1/legal-entities",
            Some(corporation("주식회사 다라", Some("000211-0006241"), false)),
        )
        .await;
    let id = saved["record"]["id"].as_str().unwrap().to_owned();
    let uri = format!("/api/v1/legal-entities/{id}/close");
    let why = |w: &str| Some(json!({ "why": w }));
    let (status, body) = c.call("DELETE", &uri, why("계속 영업")).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("legal_entity_not_closed"))
    );
    let close = json!({ "closed_on": "2026-01-31", "reason_code": "BUSINESS_CLOSED" });
    assert_eq!(c.call("POST", &uri, Some(close)).await.0, StatusCode::OK);
    let (status, body) = c.call("DELETE", &uri, why("")).await;
    assert_eq!(
        (status, body["error"]["errors"][0]["field"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("why"))
    );
    assert_eq!(audits(&pool, "legal_entity.close_withdraw").await, 0);
    let (status, body) = c
        .call("DELETE", &uri, why("폐업을 철회하고 계속 영업"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["record"]["closed_on"].is_null(), "{body}");
    assert_eq!(audits(&pool, "legal_entity.close_withdraw").await, 1);
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

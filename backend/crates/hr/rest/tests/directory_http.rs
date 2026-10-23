#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PEOPLE-B over HTTP, through the request-context layer: the export's
//! 접속기록 row carries the client IP (the trusted proxy's resolved client, else
//! the socket peer) and session, the CSV is never cached and starts
//! with a BOM, and the facets read answers with the chip counts.

use std::net::SocketAddr;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use axum::routing::get;
use console_hr_adapter_postgres::HrService;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_request_context::{TrustedClientIp, with_request_context};
use console_platform_test_support::runtime_role_pool;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: "console-platform-auth".to_owned(),
        audience: "console-api".to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

async fn send(
    service: axum::Router,
    uri: &str,
    token: &str,
    trusted_client: Option<[u8; 4]>,
) -> (StatusCode, header::HeaderMap, String) {
    let mut request = Request::builder()
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 7], 40000))));
    if let Some(ip) = trusted_client {
        // What the ingress layer inserts after walking X-Forwarded-For / CF-Connecting-IP
        // from a configured trusted proxy.
        request
            .extensions_mut()
            .insert(TrustedClientIp::new(ip.into()));
    }
    let response = service.oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn export_and_facets_over_http_log_the_client_ip_and_never_cache(pool: PgPool) {
    let org = Uuid::new_v4();
    let user = UserId::new();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'People B HTTP')")
        .bind(org)
        .bind(format!("pbh-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', ARRAY['SUPER_ADMIN'], $2)",
    )
    .bind(*user.as_uuid())
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (org_id, company, name, employee_number, employment_status, \
         source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) \
         VALUES ($1, 'Test', 'Kim', 'A-1', 'ACTIVE', 'test.xlsx', 'Sheet', 1, 'k-1', '{}', '{}')",
    )
    .bind(org)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let key = SigningKey::random(&mut OsRng);
    let private_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let public_pem = key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let issuer =
        JwtIssuer::from_es256_pem(settings(), private_pem.as_bytes(), public_pem.as_bytes())
            .unwrap();
    let token = console_platform_test_support::issue_session_token(
        &pool,
        &issuer,
        AccessTokenInput {
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
        },
        None,
        Vec::new(),
    )
    .await;
    let runtime = runtime_role_pool(&pool).await;
    let verifier = JwtVerifier::from_es256_public_pem(settings(), public_pem.as_bytes()).unwrap();
    let router = axum::Router::new()
        .route("/export.csv", get(console_hr_rest::export_employees_csv))
        .route("/facets", get(console_hr_rest::employee_facets))
        .with_state(HrService::new(runtime.clone()));
    let service = with_request_context(router, Some(verifier), runtime);

    let (status, _, body) = send(service.clone(), "/export.csv", &token, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body.contains("export_purpose_required"), "{body}");

    let (status, headers, body) = send(
        service.clone(),
        "/export.csv?export_purpose=OTHER&status=ACTIVE",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(headers[header::CONTENT_TYPE], "text/csv; charset=utf-8");
    assert!(body.starts_with("\u{feff}company,"));
    assert!(body.contains("Kim,A-1"));

    let (status, _, body) = send(
        service.clone(),
        "/export.csv?export_purpose=OTHER",
        &token,
        Some([198, 51, 100, 20]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let family: Uuid = sqlx::query_scalar(
        "SELECT id FROM auth_refresh_token_families WHERE org_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(*user.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    let sessions: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT after_snap->>'session_id' FROM audit_events \
         WHERE org_id = $1 AND action LIKE 'employee.export%'",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(sessions, vec![Some(family.to_string()); 3]);
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT action, ip FROM audit_events WHERE org_id = $1 AND action LIKE 'employee.export%' \
         ORDER BY occurred_at",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "employee.export_refused".to_owned(),
                Some("203.0.113.7".to_owned())
            ),
            ("employee.export".to_owned(), Some("203.0.113.7".to_owned())),
            (
                "employee.export".to_owned(),
                Some("198.51.100.20".to_owned())
            ),
        ]
    );

    let (status, _, body) = send(service, "/facets?status=ACTIVE", &token, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let facets: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(facets["total"], 1);
}

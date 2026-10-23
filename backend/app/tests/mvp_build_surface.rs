//! The MVP build (docs/ops/mvp-build.md) serves no route of a module compiled
//! out of it: an authenticated GET answers 404, with or without the SPA
//! fallback, while the MVP surface on the same router still answers. Each probe
//! is compiled in only when its module's feature is off, so the file holds in
//! every feature combination and is empty under `full`.

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use console_app::{
    AppConfig, AppRole, AppState, CONFIGURED_ROUTE_SURFACES, DatabaseDependency, build_router,
};
use console_kernel_core::OrgId;
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings};
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

type TestError = Box<dyn std::error::Error + Send + Sync>;

const ISSUER: &str = "console-platform-auth";
const AUDIENCE: &str = "console-api";

/// (module feature, its route surface name, a GET path it serves when compiled in).
const COMPILED_OUT: &[(&str, &str, &str)] = &[
    #[cfg(not(feature = "attendance"))]
    ("attendance", "attendance", "/api/v1/attendance/exceptions"),
    #[cfg(not(feature = "payroll"))]
    ("payroll", "payroll", "/api/v1/payroll/runs"),
    #[cfg(not(feature = "inventory"))]
    ("inventory", "inventory", "/api/v1/inventory/items"),
    #[cfg(not(feature = "workorder"))]
    ("workorder", "workorder", "/api/v1/equipment"),
    #[cfg(not(feature = "dispatch"))]
    ("dispatch", "dispatch", "/api/v1/console/dispatch/queue"),
    #[cfg(not(feature = "financial"))]
    ("financial", "financial", "/api/v1/financial/rental-quotes"),
    #[cfg(not(feature = "mail"))]
    ("mail", "comms", "/api/v1/mail/account"),
    #[cfg(not(feature = "workspace"))]
    (
        "workspace",
        "workflow-studio",
        "/api/v1/workflow-studio/catalog",
    ),
];

fn router(
    pool: PgPool,
    public_pem: String,
    web_dist: Option<&std::path::Path>,
) -> Result<axum::Router, TestError> {
    let mut pairs = vec![
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ];
    if let Some(dist) = web_dist {
        pairs.push(("CONSOLE_WEB_DIST", dist.display().to_string()));
    }
    let config = AppConfig::from_pairs(pairs)?;
    Ok(build_router(AppState::new(
        config,
        DatabaseDependency::Postgres(pool),
    )?))
}

async fn admin_token(
    pool: &PgPool,
    private_pem: &str,
    public_pem: &str,
) -> Result<String, TestError> {
    let branch = console_platform_test_support::seed_branch(pool, "MVP region", "MVP branch").await;
    let user = console_platform_test_support::seed_user(pool, "MVP admin", "ADMIN", branch).await;
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: ISSUER.to_owned(),
            audience: AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        private_pem.as_bytes(),
        public_pem.as_bytes(),
    )?;
    Ok(console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::one(),
            roles: vec!["ADMIN".to_owned()],
            branches: vec![branch],
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
        vec![],
    )
    .await)
}

async fn get(
    router: &axum::Router,
    uri: &str,
    token: &str,
) -> Result<(StatusCode, String), TestError> {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn compiled_out_module_routes_answer_404_and_mvp_routes_answer(
    pool: PgPool,
) -> Result<(), TestError> {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF)?.to_string();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)?;
    let token = admin_token(&pool, &private_pem, &public_pem).await?;
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;

    // Production serves the SPA as the fallback: a compiled-out API path must
    // still be a JSON 404, never index.html.
    let dist = std::env::temp_dir().join(format!("mvp-dist-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dist)?;
    std::fs::write(dist.join("index.html"), "<!doctype html><title>spa</title>")?;
    let dist: Arc<std::path::Path> = dist.into();

    for web_dist in [None, Some(&*dist)] {
        let app = router(runtime.clone(), public_pem.clone(), web_dist)?;
        // Control: the MVP org surface is mounted on this very router.
        let (status, body) = get(&app, "/api/v1/org-units", &token).await?;
        assert_ne!(status, StatusCode::NOT_FOUND, "MVP route missing: {body}");
        for (module, _, path) in COMPILED_OUT {
            let (status, body) = get(&app, path, &token).await?;
            assert_eq!(
                status,
                StatusCode::NOT_FOUND,
                "{module} is compiled out, so {path} must 404 (spa={}): {body}",
                web_dist.is_some()
            );
            assert!(
                !body.contains("<!doctype html>"),
                "{path} fell through to the SPA"
            );
        }
    }
    std::fs::remove_dir_all(&*dist)?;
    Ok(())
}

#[test]
fn compiled_out_modules_list_no_route_surface() {
    for (module, surface_name, _) in COMPILED_OUT {
        assert!(
            !CONFIGURED_ROUTE_SURFACES
                .iter()
                .any(|surface| surface.name == *surface_name),
            "{module} is compiled out but still lists a route surface"
        );
    }
}

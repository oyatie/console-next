use super::*;
use axum::body::{Body, to_bytes};
use axum::http::Request;
use console_platform_auth::AccessClaims;
use console_platform_provisioning::PlatformProvisioner;
use console_platform_test_support::runtime_role_pool;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn fixture(pool: &PgPool) -> (PlatformRestState, PlatformPrincipal, AccessClaims) {
    let org = OrgId::platform();
    sqlx::query("INSERT INTO organizations (id,slug,name,status) VALUES ($1,'platform','Platform','ARCHIVED') ON CONFLICT (id) DO NOTHING")
        .bind(org.as_uuid()).execute(pool).await.unwrap();
    let user = UserId::new();
    let family = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'Operator',ARRAY['SUPER_ADMIN'])")
        .bind(user.as_uuid()).bind(org.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO auth_refresh_token_families (id,user_id,org_id,created_at) VALUES ($1,$2,$3,now())")
        .bind(family).bind(user.as_uuid()).bind(org.as_uuid()).execute(pool).await.unwrap();
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let claims = serde_json::from_value(json!({
        "iss":"test", "aud":"test", "sub":user.to_string(), "org":org.to_string(),
        "iat":now, "nbf":now, "exp":now+3600, "jti":Uuid::new_v4().to_string(),
        "roles":["SUPER_ADMIN"], "branches":[], "platform":true, "alg":"ES256",
        "session_family_id":family
    }))
    .unwrap();
    (
        PlatformRestState::new(
            runtime_role_pool(pool).await,
            None,
            PlatformProvisioner::new(time::Duration::minutes(15)),
        ),
        PlatformPrincipal::new(user),
        claims,
    )
}

fn extracted_service(
    state: PlatformRestState,
    principal: PlatformPrincipal,
    claims: AccessClaims,
) -> Router {
    // These trusted extensions model a request already authenticated by middleware.
    Router::new()
        .route(PLATFORM_GROUPS_PATH, get(list_groups))
        .route(PLATFORM_ORGS_PATH, get(list_orgs))
        .route(
            PLATFORM_COMPANY_DOMAIN_PATH,
            get(company_domain::availability),
        )
        .route(PLATFORM_OPS_PATH, get(ops_dashboard))
        .with_state(state)
        .layer(Extension(principal))
        .layer(Extension(claims))
}

async fn request(service: &Router, path: &str) -> (StatusCode, Value) {
    let response = service
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

async fn audit_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action IN ('platform.group.list','platform.tenant.list','platform.tenant.health','platform.tenant.domain.check')")
        .fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn listings_recheck_role_and_family_after_middleware_without_read_audits(pool: PgPool) {
    let (state, principal, claims) = fixture(&pool).await;
    console_platform_request_context::validate_current_claims(&state.pool, &claims)
        .await
        .unwrap();
    let service = extracted_service(state, principal.clone(), claims.clone());
    for path in [
        PLATFORM_GROUPS_PATH,
        PLATFORM_ORGS_PATH,
        PLATFORM_OPS_PATH,
        "/api/platform/company-domain?slug=platform",
    ] {
        assert_eq!(request(&service, path).await.0, StatusCode::OK);
    }
    let before = audit_count(&pool).await;
    for change in ["role", "family", "account"] {
        match change {
            "role" => {
                sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE id=$1")
                    .bind(principal.user_id.as_uuid())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "family" => {
                sqlx::query("UPDATE auth_refresh_token_families SET revoked_at=now() WHERE id=$1")
                    .bind(claims.session_family_id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
                    .bind(principal.user_id.as_uuid())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        }
        for path in [
            PLATFORM_GROUPS_PATH,
            PLATFORM_ORGS_PATH,
            PLATFORM_OPS_PATH,
            "/api/platform/company-domain?slug=platform",
        ] {
            let (status, body) = request(&service, path).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{change}: {path}: {body}");
            assert_eq!(body["error"]["code"], "unauthorized");
            assert_eq!(
                audit_count(&pool).await,
                before,
                "denied listing cannot read/audit"
            );
        }
        sqlx::query("UPDATE users SET roles=ARRAY['SUPER_ADMIN'],is_active=true WHERE id=$1")
            .bind(principal.user_id.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE auth_refresh_token_families SET revoked_at=NULL WHERE id=$1")
            .bind(claims.session_family_id)
            .execute(&pool)
            .await
            .unwrap();
    }
}

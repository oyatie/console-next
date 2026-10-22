use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use console_kernel_core::{AuditAction, AuditEvent, AuditRequestContext, OrgId, TraceContext};
use console_platform_db::{DbError, with_audits};
use console_platform_request_context::current_audit_context;
use serde::Deserialize;
use sqlx::PgPool;
use time::OffsetDateTime;

const TERMS_V1: &str =
    "E2E service terms fixture. This is a test document, not a published contract.";
const TERMS_REVISED: &str =
    "Revised E2E service terms fixture. This is a test document, not a published contract.";

pub(super) fn router(pool: PgPool) -> Router {
    let router = Router::new().route("/__e2e/terms", post(publish_terms));
    // Mounted like every other E2E fixture: in a debug build or the explicit E2E support binary (the module itself is
    // compiled only there) and, at run time, only with the E2E stub mail mode (platform.rs).
    let router = router
        .route("/__e2e/ops-recovery/operator", post(recovery_operator))
        .route("/__e2e/ops-recovery/elapse", post(recovery_elapse));
    router.with_state(pool)
}

#[derive(Deserialize)]
struct PublishTermsRequest {
    version: String,
}

async fn publish_terms(
    State(pool): State<PgPool>,
    Json(request): Json<PublishTermsRequest>,
) -> Result<StatusCode, StatusCode> {
    let Some(body) = terms_body(&request.version) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    // Global E2E setup calls this route before any tenant exists. Use the
    // platform sentinel scope, as other platform mutations do, while retaining
    // request metadata when the shared middleware supplied it.
    let (trace, request_context) = current_audit_context()
        .map(|context| (context.trace, context.request))
        .unwrap_or_else(|| (TraceContext::generate(), AuditRequestContext::default()));
    let action =
        AuditAction::new("e2e.terms.publish").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let version = request.version;
    let status = with_audits(&pool, OrgId::platform(), move |tx| {
        Box::pin(async move {
            let inserted = sqlx::query(
                "INSERT INTO terms_documents (version, body, published_at) VALUES ($1, $2, clock_timestamp()) ON CONFLICT (version) DO NOTHING",
            )
            .bind(&version)
            .bind(body)
            .execute(tx.as_mut())
            .await?;
            let stored: Option<String> =
                sqlx::query_scalar("SELECT body FROM terms_documents WHERE version = $1")
                    .bind(&version)
                    .fetch_optional(tx.as_mut())
                    .await?;
            if stored.as_deref() != Some(body) {
                return Ok::<_, DbError>((StatusCode::CONFLICT, Vec::new()));
            }
            let events = if inserted.rows_affected() > 0 {
                vec![AuditEvent::new(
                    None,
                    action,
                    "terms_document",
                    version,
                    trace,
                    OffsetDateTime::now_utc(),
                )
                .with_request_context(request_context)]
            } else {
                Vec::new()
            };
            Ok::<_, DbError>((StatusCode::NO_CONTENT, events))
        })
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if status != StatusCode::NO_CONTENT {
        return Err(status);
    }
    Ok(status)
}

fn terms_body(version: &str) -> Option<&'static str> {
    let suffix = version.strip_prefix("e2e-v")?;
    let number = suffix.parse::<u32>().ok()?;
    if number == 0 || number.to_string() != suffix {
        return None;
    }
    Some(if number == 1 { TERMS_V1 } else { TERMS_REVISED })
}

#[cfg(test)]
mod tests {
    use super::{TERMS_REVISED, TERMS_V1, terms_body};

    #[test]
    fn only_canonical_e2e_versions_select_fixture_text() {
        assert_eq!(terms_body("e2e-v1"), Some(TERMS_V1));
        assert_eq!(terms_body("e2e-v27"), Some(TERMS_REVISED));
        for invalid in ["v1", "e2e-v0", "e2e-v01", "e2e-vx", "terms-v1"] {
            assert_eq!(terms_body(invalid), None, "accepted {invalid}");
        }
    }

    // regression (train fix r1): the ops-recovery fixtures were mounted only with `e2e-test-support`, so the debug
    // binary every E2E run uses answered 404 and e2e/ops-recovery.spec.ts could never start. A malformed body is
    // refused by the JSON extractor before the (lazy, never connected) pool is touched; an unmounted route is a 404.
    #[tokio::test]
    async fn ops_recovery_fixtures_are_mounted_in_the_e2e_debug_build() {
        use tower::ServiceExt;
        let pool = sqlx::PgPool::connect_lazy("postgres://fixture@127.0.0.1:1/none").unwrap();
        for uri in ["/__e2e/ops-recovery/operator", "/__e2e/ops-recovery/elapse"] {
            let request = http::Request::post(uri)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap();
            let status = super::router(pool.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status();
            assert_eq!(status, http::StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
        }
    }
}

#[cfg(all(test, feature = "e2e-test-support"))]
mod route_tests {
    use super::router;
    use axum::body::Body;
    use http::{Request, StatusCode, header};
    use sqlx::PgPool;
    use tower::ServiceExt;

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn global_setup_publishes_terms_without_a_tenant_and_audits_once(pool: PgPool) {
        let response = router(pool.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/__e2e/terms")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"version":"e2e-v1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let audit_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'e2e.terms.publish'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audit_rows, 1);
    }
}

#[derive(Deserialize)]
struct RecoveryOperatorRequest {
    name: String,
}
async fn recovery_operator(
    State(pool): State<PgPool>,
    Json(body): Json<RecoveryOperatorRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let id=with_audits(&pool,OrgId::platform(),move |tx| Box::pin(async move {
        let id:uuid::Uuid=sqlx::query_scalar("INSERT INTO users(org_id,display_name,roles) VALUES($1,$2,ARRAY['SUPER_ADMIN']) RETURNING id")
            .bind(OrgId::platform().as_uuid()).bind(body.name).fetch_one(tx.as_mut()).await?;
        let event=AuditEvent::new(None,AuditAction::new("e2e.ops_recovery.operator").map_err(|err|DbError::CodeIssuance(err.to_string()))?,"user",id.to_string(),TraceContext::generate(),OffsetDateTime::now_utc()).with_org(OrgId::platform());
        Ok::<_,DbError>((id,vec![event]))
    })).await.map_err(|_|StatusCode::INTERNAL_SERVER_ERROR)?;
    let issue = console_platform_provisioning::BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            None,
            id,
            OrgId::platform(),
            OffsetDateTime::now_utc(),
            time::Duration::minutes(10),
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        serde_json::json!({"id":id,"otp":issue.token.as_str()}),
    ))
}
#[derive(Deserialize)]
struct RecoveryElapseRequest {
    org_id: uuid::Uuid,
    id: uuid::Uuid,
}
async fn recovery_elapse(
    State(pool): State<PgPool>,
    Json(body): Json<RecoveryElapseRequest>,
) -> Result<StatusCode, StatusCode> {
    let org = OrgId::from_uuid(body.org_id);
    with_audits(&pool,org,move |tx|Box::pin(async move {
        let changed=sqlx::query("UPDATE ops_recovery_requests SET hold_until=clock_timestamp()-interval '1 second' WHERE org_id=$1 AND id=$2 AND approved_by IS NOT NULL AND issued_at IS NULL AND cancelled_at IS NULL")
            .bind(body.org_id).bind(body.id).execute(tx.as_mut()).await?.rows_affected();
        let event=AuditEvent::new(None,AuditAction::new("e2e.ops_recovery.elapse").map_err(|err|DbError::CodeIssuance(err.to_string()))?,"ops_recovery_request",body.id.to_string(),TraceContext::generate(),OffsetDateTime::now_utc()).with_org(org);
        Ok::<_,DbError>((changed,vec![event]))
    })).await.map_err(|_|StatusCode::INTERNAL_SERVER_ERROR).and_then(|changed|if changed==1 {Ok(StatusCode::NO_CONTENT)}else{Err(StatusCode::NOT_FOUND)})
}

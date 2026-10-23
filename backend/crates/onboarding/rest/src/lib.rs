//! Setup-phase REST face (entity-depth design §5–§6).
//!
//! The rail is readable through live setup grants; the preview and 운영 시작 needs SUPER_ADMIN, a fresh passkey step-up of the
//! caller's own passkey and the digest of the preview they confirmed (the
//! adapter re-checks every fact under lock; Cedar and the Rust backstop must
//! both allow). Terms need the live ops holder; step skips need their own tenant-wide Cedar grant.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod error;
use error::RestError;
mod openapi;
pub use openapi::OPENAPI_FRAGMENT;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use console_kernel_core::{ErrorKind, TraceContext};
use console_onboarding_adapter_postgres::{OnboardingActor, PgOnboardingError, PgOnboardingStore};
use console_platform_auth::{JwtVerifier, PasskeyAuthenticationCredential, PasskeyService};
use console_platform_authz::Principal;
use serde::Deserialize;
use uuid::Uuid;

pub const CHECKLIST_PATH: &str = "/api/v1/onboarding/checklist";
pub const GO_LIVE_PREVIEW_PATH: &str = "/api/v1/onboarding/go-live/preview";
pub const GO_LIVE_PATH: &str = "/api/v1/onboarding/go-live";
pub const TERMS_PATH: &str = "/api/v1/onboarding/terms";
pub const STEP_SKIP_PATH: &str = "/api/v1/onboarding/steps/{step}/skip";

pub const ONBOARDING_ROUTE_PATHS: &[&str] = &[
    CHECKLIST_PATH,
    GO_LIVE_PREVIEW_PATH,
    GO_LIVE_PATH,
    TERMS_PATH,
    STEP_SKIP_PATH,
];

#[derive(Clone)]
pub struct OnboardingRestState {
    store: PgOnboardingStore,
    jwt_verifier: Option<JwtVerifier>,
    passkey_step_up: Option<PasskeyService>,
}

impl OnboardingRestState {
    #[must_use]
    pub fn new(
        store: PgOnboardingStore,
        jwt_verifier: Option<JwtVerifier>,
        passkey_step_up: Option<PasskeyService>,
    ) -> Self {
        Self {
            store,
            jwt_verifier,
            passkey_step_up,
        }
    }
}

pub fn router(state: OnboardingRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(CHECKLIST_PATH, get(checklist))
        .route(GO_LIVE_PREVIEW_PATH, get(go_live_preview))
        .route(GO_LIVE_PATH, post(go_live))
        .route(TERMS_PATH, post(accept_terms))
        .route(STEP_SKIP_PATH, post(skip_step))
        .with_state(state.clone());
    console_platform_request_context::with_request_context(router, verifier, pool).merge(
        Router::new()
            .route(TERMS_PATH, get(terms))
            .with_state(state),
    )
}

async fn actor(s: &OnboardingRestState, headers: &HeaderMap) -> Result<OnboardingActor, RestError> {
    let verifier = s.jwt_verifier.as_ref().ok_or_else(|| {
        RestError(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured".into(),
            vec![],
            None,
            None,
        )
    })?;
    let p: Principal =
        console_platform_request_context::resolve_principal(verifier, s.store.pool(), headers)
            .await
            .map_err(|_| {
                RestError(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "missing or invalid bearer token".into(),
                    vec![],
                    None,
                    None,
                )
            })?;
    Ok(OnboardingActor {
        org: p.org_id,
        user: p.user_id,
        roles: p.roles.iter().map(|r| r.as_str().to_owned()).collect(),
        trace: TraceContext::generate(),
    })
}

async fn checklist(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    Ok(Json(s.store.checklist(&a).await?).into_response())
}

async fn go_live_preview(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    Ok(Json(s.store.preview(&a).await?).into_response())
}

#[derive(Debug, Deserialize)]
struct StepUp {
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Deserialize)]
struct GoLiveBody {
    digest: String,
    #[serde(default)]
    line_digests: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    sole_holder_acknowledged: bool,
    step_up: Option<StepUp>,
}

async fn go_live(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
    Json(b): Json<GoLiveBody>,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    s.store.authorize_go_live(&a).await?;
    let Some(step_up) = b.step_up else {
        s.store
            .record_refusal(&a, "passkey_step_up_required", &[])
            .await?;
        return Err(RestError(
            StatusCode::PRECONDITION_REQUIRED,
            "passkey_step_up_required",
            "운영 시작 requires a fresh passkey step-up".into(),
            vec![],
            Some("passkey_step_up"),
            None,
        ));
    };
    let passkeys = s.passkey_step_up.as_ref().ok_or_else(|| {
        RestError(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "passkey step-up is not configured".into(),
            vec![],
            None,
            None,
        )
    })?;
    // the ceremony is bound to the caller's own passkey, not to the
    // digest (auth has no generic payload binding yet); the digest is checked
    // server-side under lock instead. Add a TENANT_GO_LIVE binding kind with
    // the F-CEDAR step-up migration.
    let verified = passkeys
        .verify_step_up_for_user(
            s.store.pool(),
            step_up.ceremony_id,
            step_up.credential,
            *a.user.as_uuid(),
        )
        .await;
    if verified.is_err() {
        s.store
            .record_refusal(&a, "passkey_step_up_failed", &[])
            .await?;
        return Err(RestError(
            StatusCode::UNAUTHORIZED,
            "passkey_step_up_failed",
            "passkey step-up failed".into(),
            vec![],
            Some("passkey_step_up"),
            None,
        ));
    }
    let done = s
        .store
        .go_live_with_lines(
            &a,
            b.digest,
            b.line_digests,
            b.sole_holder_acknowledged,
            true,
        )
        .await?;
    Ok(Json(done).into_response())
}

#[derive(Debug, Deserialize)]
struct TermsBody {
    version: Option<String>,
    sha256: Option<String>,
    terms_version: Option<String>,
}

async fn terms(State(s): State<OnboardingRestState>, h: HeaderMap) -> Result<Response, RestError> {
    // Published legal documents are readable before enrollment and by either account tier.
    let token = h
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| document_error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let claims = s
        .jwt_verifier
        .as_ref()
        .ok_or_else(|| document_error(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?
        .verify_access_token(token)
        .map_err(|_| document_error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let (user, org) =
        console_platform_request_context::validate_current_claims(s.store.pool(), &claims)
            .await
            .map_err(|_| document_error(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let mut tx = s
        .store
        .pool()
        .begin()
        .await
        .map_err(|_| document_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?;
    let documents = match console_platform_request_context::privacy::documents_in_tx(&mut tx).await
    {
        Ok(documents) => documents,
        Err(sqlx::Error::RowNotFound) => {
            tx.rollback()
                .await
                .map_err(|_| document_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?;
            let actor = OnboardingActor {
                org,
                user,
                roles: claims.roles,
                trace: TraceContext::generate(),
            };
            s.store
                .record_refusal(&actor, "terms_not_published", &[])
                .await?;
            return Err(document_error(StatusCode::CONFLICT, "terms_not_published"));
        }
        Err(_) => {
            return Err(document_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
            ));
        }
    };
    tx.commit()
        .await
        .map_err(|_| document_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?;
    Ok(Json(documents).into_response())
}

async fn accept_terms(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
    Json(b): Json<TermsBody>,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    match (b.version, b.sha256, b.terms_version) {
        (Some(version), Some(hash), legacy) if legacy.as_ref().is_none_or(|v| *v == version) => {
            s.store.accept_terms(&a, version, hash).await?;
        }
        (None, None, Some(version)) => s.store.accept_terms_version(&a, version).await?,
        _ => {
            s.store.record_refusal(&a, "validation_failed", &[]).await?;
            return Err(RestError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_failed",
                "validation_failed".into(),
                vec![],
                Some("review_terms"),
                None,
            ));
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn skip_step(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
    Path(step): Path<String>,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    s.store.skip_step(&a, &step).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn document_error(status: StatusCode, code: &'static str) -> RestError {
    RestError(
        status,
        code,
        code.into(),
        vec![],
        (code == "terms_not_published").then_some("contact_service_operator"),
        None,
    )
}

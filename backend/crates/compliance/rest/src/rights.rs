// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant-session self-service privacy rights. Intake administration is separate.
use super::{ComplianceRestState, RestError, principal_from_headers};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use console_compliance_adapter_postgres::rights;
use console_compliance_domain::rights::{Controller, Filing};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
};
use console_platform_authz::cedar_pbac::visible::load_facts;
use serde::Deserialize;
use serde_json::Value;

pub const PATH: &str = "/api/v1/privacy/rights-requests";
pub const MINE: &str = "/api/v1/privacy/rights-requests/mine";
pub const ROUTE_PATHS: &[&str] = &[PATH, MINE];

pub fn router(state: ComplianceRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    console_platform_request_context::with_request_context(
        Router::new()
            .route(MINE, get(mine))
            .route(PATH, post(file))
            .with_state(state),
        verifier,
        pool,
    )
}
#[derive(Deserialize)]
struct Page {
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    controller: Controller,
    kinds: Vec<console_compliance_domain::rights::Kind>,
    #[serde(default)]
    detail: String,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}
fn unavailable(_: impl std::fmt::Display) -> RestError {
    RestError::unavailable("privacy request storage unavailable")
}
fn store_error(error: console_compliance_adapter_postgres::PgComplianceError) -> RestError {
    use console_compliance_adapter_postgres::PgComplianceError;
    match error {
        PgComplianceError::Domain(e) => RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            e.code.unwrap_or("request_invalid"),
            e.message,
        ),
        _ => unavailable(error),
    }
}
async fn mine(
    State(state): State<ComplianceRestState>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> Result<Json<Value>, RestError> {
    let actor = principal_from_headers(&state, &headers).await?;
    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let facts = load_facts(&mut tx, actor.org_id, *actor.user_id.as_uuid())
        .await
        .map_err(unavailable)?;
    if !facts
        .authorize_privacy_request_read(*actor.user_id.as_uuid())
        .map_err(unavailable)?
    {
        return Err(RestError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "privacy request read refused",
        ));
    }
    let page = rights::mine(&mut tx, actor.user_id, page.cursor.as_deref(), 50)
        .await
        .map_err(store_error)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Json(page))
}
async fn file(
    State(state): State<ComplianceRestState>,
    headers: HeaderMap,
    Json(body): Json<File>,
) -> Result<Json<Value>, RestError> {
    let actor = principal_from_headers(&state, &headers).await?;
    let step_up = body.step_up.ok_or_else(|| {
        RestError::new(
            StatusCode::FORBIDDEN,
            "passkey_step_up_required",
            "a fresh passkey assertion is required",
        )
    })?;
    let verifier = state
        .passkey_step_up
        .as_ref()
        .ok_or_else(|| RestError::unavailable("passkey verification unavailable"))?;
    let input = Filing {
        controller: body.controller,
        kinds: body.kinds,
        detail: body.detail,
    };
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PrivacyRequest,
        *actor.user_id.as_uuid(),
        rights::filing_hash(state.store.pool(), &input)
            .await
            .map_err(unavailable)?,
    );
    verifier
        .verify_mobile_step_up_for_user(
            state.store.pool(),
            step_up,
            *actor.user_id.as_uuid(),
            &binding,
        )
        .await
        .map_err(|_| {
            RestError::new(
                StatusCode::FORBIDDEN,
                "passkey_step_up_failed",
                "passkey verification failed",
            )
        })?;
    let mut tx = rights::begin(state.store.pool(), actor.org_id)
        .await
        .map_err(unavailable)?;
    let facts = load_facts(&mut tx, actor.org_id, *actor.user_id.as_uuid())
        .await
        .map_err(unavailable)?;
    let hr = input.controller == Controller::Tenant;
    if !facts
        .authorize_privacy_request(*actor.user_id.as_uuid(), hr)
        .map_err(unavailable)?
    {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "no_employee_record",
            "no linked employee record",
        ));
    }
    let register = state
        .store
        .statutory_register()
        .await
        .map_err(unavailable)?;
    let result = rights::file(
        &mut tx,
        actor.org_id,
        actor.user_id,
        facts.linked_employee_id(),
        &input,
        &register,
    )
    .await
    .map_err(store_error)?;
    tx.commit().await.map_err(unavailable)?;
    Ok(Json(result))
}

//! Notice-board (bulletin board, NT- notices) REST API.
//!
//! A published notice's title/body/audience is readable by any authenticated
//! org member; drafts, draft edits, publish, progress, and the receipts drill
//! are gated behind [`Feature::NoticeManage`] (the HQ/announcement tier).
//! Receipt acknowledgment is recipient-scoped from the
//! authenticated principal, exactly like the notifications mark-read idiom —
//! never from request input. Draft existence never leaks to non-managers
//! (404/list omission); manager-only aggregates answer 403 (the feature's
//! existence is not a secret, its data is).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod error;
use error::RestError;
mod openapi;
pub use openapi::OPENAPI_FRAGMENT;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use console_kernel_core::{BranchId, KernelError, NoticeId, TraceContext};
use console_notices_adapter_postgres::PgNoticeStore;
use console_notices_application::{
    AcknowledgeNoticeCommand, CreateDraftNoticeCommand, GetNoticeQuery, ListNoticeReceiptsQuery,
    ListNoticesQuery, NoticeAudienceInput, NoticeProgressQuery, PublishNoticeCommand,
    UpdateDraftNoticeCommand,
};
use console_platform_auth::JwtVerifier;
use console_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use console_platform_request_context::RequestContextError;
use serde::Deserialize;

pub const NOTICES_PATH: &str = "/api/v1/notices";
pub const NOTICE_PATH_TEMPLATE: &str = "/api/v1/notices/{id}";
pub const NOTICE_PUBLISH_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/publish";
pub const NOTICE_ACK_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/ack";
pub const NOTICE_PROGRESS_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/progress";
pub const NOTICE_RECEIPTS_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/receipts";

pub const NOTICES_ROUTE_PATHS: &[&str] = &[
    NOTICES_PATH,
    NOTICE_PATH_TEMPLATE,
    NOTICE_PUBLISH_PATH_TEMPLATE,
    NOTICE_ACK_PATH_TEMPLATE,
    NOTICE_PROGRESS_PATH_TEMPLATE,
    NOTICE_RECEIPTS_PATH_TEMPLATE,
];

const RECEIPTS_DEFAULT_LIMIT: i64 = 50;
const RECEIPTS_MAX_LIMIT: i64 = 200;

#[derive(Debug, Clone)]
pub struct NoticeRestState {
    store: PgNoticeStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl NoticeRestState {
    #[must_use]
    pub fn new(store: PgNoticeStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: NoticeRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(NOTICES_PATH, get(list_notices).post(create_draft))
        .route(NOTICE_PATH_TEMPLATE, get(get_notice).patch(update_draft))
        .route(NOTICE_PUBLISH_PATH_TEMPLATE, post(publish_notice))
        .route(NOTICE_ACK_PATH_TEMPLATE, post(acknowledge_notice))
        .route(NOTICE_PROGRESS_PATH_TEMPLATE, get(notice_progress))
        .route(NOTICE_RECEIPTS_PATH_TEMPLATE, get(notice_receipts))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct ListParams {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ReceiptsParams {
    acknowledged: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// Check notice publication against its intended audience. Only a concrete branch
/// permits a branch-scoped publisher; a shared audience requires tenant-wide authority.
pub fn authorize_publication(
    principal: &Principal,
    branch: Option<BranchId>,
) -> Result<(), KernelError> {
    let action = Action::new(Feature::NoticeManage);
    match branch {
        Some(branch) => authorize(principal, action, branch),
        None => authorize_org_wide(principal, action),
    }
}

/// `true` when the principal holds the publish tier (draft visibility +
/// publish/progress/receipts + per-row progress hydration). Deny-by-default
/// on the authz check: any error (missing grant, scope failure, …) is treated
/// as "not a manager", not surfaced.
fn is_notice_manager(principal: &Principal) -> bool {
    authorize_publication(principal, None).is_ok()
}

fn require_notice_manager(principal: &Principal) -> Result<(), RestError> {
    authorize_publication(principal, None).map_err(RestError::from_kernel)
}

async fn create_draft(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateDraftBody>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let summary = state
        .store
        .create_draft(CreateDraftNoticeCommand {
            author: principal.user_id,
            title: body.title,
            body: body.body,
            category: body.category,
            audience: body.audience,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)).into_response())
}

async fn update_draft(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
    Json(body): Json<UpdateDraftBody>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let summary = state
        .store
        .update_draft(UpdateDraftNoticeCommand {
            notice_id,
            editor: principal.user_id,
            title: body.title,
            body: body.body,
            category: body.category,
            audience: body.audience,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary).into_response())
}

async fn list_notices(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let items = state
        .store
        .list(ListNoticesQuery {
            include_drafts: is_notice_manager(&principal),
            limit: params.limit.unwrap_or(50),
            viewer: principal.user_id,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(items).into_response())
}

async fn get_notice(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .get(
            GetNoticeQuery {
                notice_id,
                viewer: principal.user_id,
            },
            is_notice_manager(&principal),
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary).into_response())
}

async fn publish_notice(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let summary = state
        .store
        .publish(PublishNoticeCommand {
            notice_id,
            publisher: principal.user_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary).into_response())
}

async fn acknowledge_notice(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    state
        .store
        .acknowledge(AcknowledgeNoticeCommand {
            notice_id,
            recipient: principal.user_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn notice_progress(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let progress = state
        .store
        .progress(NoticeProgressQuery { notice_id })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(progress).into_response())
}

async fn notice_receipts(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
    Query(params): Query<ReceiptsParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let page = state
        .store
        .list_receipts(ListNoticeReceiptsQuery {
            notice_id,
            acknowledged: params.acknowledged,
            limit: params
                .limit
                .unwrap_or(RECEIPTS_DEFAULT_LIMIT)
                .clamp(1, RECEIPTS_MAX_LIMIT),
            offset: params.offset.unwrap_or(0).max(0),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

async fn principal_from_headers(
    state: &NoticeRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for notices API")
    })?;
    console_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(err: RequestContextError) -> RestError {
    match err {
        RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for notices API")
        }
        RequestContextError::WrongTokenTier => {
            RestError::unauthorized("token tier is not valid for this route")
        }
        RequestContextError::AccessScope(error) => RestError::from_kernel(error),
        RequestContextError::BranchScope(message)
        | RequestContextError::EffectivePolicy(message) => {
            RestError::from_kernel(KernelError::internal(message))
        }
        RequestContextError::MissingOrg => RestError::from_kernel(KernelError::internal(
            "no tenant context is bound to the current request",
        )),
        RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        RequestContextError::InvalidToken => RestError::unauthorized("invalid bearer token"),
        RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

#[cfg(test)]
#[path = "lib_unknown_fields.rs"]
mod unknown_fields_tests;

mod request_bodies;
use request_bodies::*;

// SPDX-License-Identifier: LicenseRef-Proprietary
//! Asking a colleague for a follow-up, and the owner's answer. Asking and the
//! picker of whom to ask need a to-do request grant; whom it reaches is decided
//! by Cedar in the store. Listing and withdrawing reach the caller's own
//! requests, and the return only the caller's own todos, so a caller without
//! the grant or of another tenant finds nothing there to act on.

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_kernel_core::{KernelError, TodoId, TraceContext, UserId};
use console_platform_authz::{Feature, Principal};
use console_todos_application::{
    CreateTodoRequestCommand, ListTodoAssigneesQuery, ListTodoRequestsQuery, ReturnTodoCommand,
    WithdrawTodoRequestCommand,
};
use console_todos_domain::{RequestLink, RequestState};
use serde::Deserialize;
use time::{Date, OffsetDateTime};

use crate::{RestError, TodoRestState, principal_from_headers};

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Deserialize)]
pub(crate) struct TodoAskRequest {
    assignee_account_id: UserId,
    text: String,
    #[serde(default, with = "iso_date::option")]
    due_on: Option<Date>,
    #[serde(default)]
    links: Vec<RequestLink>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReturnTodoRequest {
    note: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListRequestsParams {
    state: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListAssigneesParams {
    search: Option<String>,
    limit: Option<i64>,
}

/// Whether the caller may ask anyone at all: never a support session, else
/// the tenant's ops account or a holder of a to-do request grant. Whom it may
/// ask is decided by Cedar in the store, inside the same transaction.
pub(crate) fn may_ask(principal: &Principal) -> bool {
    principal.support.is_none()
        && (principal.is_tenant_ops || principal.scopes_for(Feature::TodoAssign).next().is_some())
}

fn ensure_may_ask(principal: &Principal) -> Result<(), RestError> {
    if may_ask(principal) {
        return Ok(());
    }
    Err(RestError::from_kernel(
        KernelError::forbidden("asking a colleague needs a to-do request grant")
            .with_code("todo_assign_forbidden"),
    ))
}

pub(crate) async fn create_request(
    State(state): State<TodoRestState>,
    headers: HeaderMap,
    body: Result<Json<TodoAskRequest>, JsonRejection>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    ensure_may_ask(&principal)?;
    // The parser's own text can quote what was sent, so it never reaches the caller.
    let Json(body) = body.map_err(|_| {
        RestError::from_kernel(KernelError::validation(
            "the body must carry assignee_account_id and text, with an optional due_on and links",
        ))
    })?;
    let summary = state
        .store
        .create_request(CreateTodoRequestCommand {
            requester: principal.user_id,
            assignee: body.assignee_account_id,
            text: body.text,
            due_on: body.due_on,
            links: body.links,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)).into_response())
}

pub(crate) async fn list_assignees(
    State(state): State<TodoRestState>,
    headers: HeaderMap,
    Query(params): Query<ListAssigneesParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    ensure_may_ask(&principal)?;
    let page = state
        .store
        .list_assignees(ListTodoAssigneesQuery {
            requester: principal.user_id,
            search: params.search,
            limit: params.limit.unwrap_or(20),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

pub(crate) async fn list_requests(
    State(state): State<TodoRestState>,
    headers: HeaderMap,
    Query(params): Query<ListRequestsParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let filter = RequestState::parse(params.state.as_deref().unwrap_or("open"))
        .map_err(RestError::from_kernel)?;
    let page = state
        .store
        .list_requests(ListTodoRequestsQuery {
            requester: principal.user_id,
            state: filter,
            limit: params.limit.unwrap_or(100),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

pub(crate) async fn withdraw(
    State(state): State<TodoRestState>,
    headers: HeaderMap,
    Path(todo_id): Path<TodoId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    state
        .store
        .withdraw_request(WithdrawTodoRequestCommand {
            requester: principal.user_id,
            todo_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn return_todo(
    State(state): State<TodoRestState>,
    headers: HeaderMap,
    Path(todo_id): Path<TodoId>,
    Json(body): Json<ReturnTodoRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    state
        .store
        .return_request(ReturnTodoCommand {
            owner: principal.user_id,
            todo_id,
            note: body.note,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests;

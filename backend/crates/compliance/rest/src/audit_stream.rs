// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    AuditStreamRequest, ComplianceRestState, RestError, audit_stream_authorizer,
    principal_from_headers,
};
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::IntoResponse;
use console_compliance_application::{AuditStreamQuery, AuditStreamReadKind};
use console_kernel_core::KernelError;
use serde::Serialize;

pub(super) async fn list_ceo_covert_audit_events(
    State(state): State<ComplianceRestState>,
    headers: HeaderMap,
    Query(query): Query<AuditStreamRequest>,
) -> Result<impl IntoResponse, RestError> {
    list_ceo_covert_audit_stream(state, headers, query, AuditStreamReadKind::Events).await
}

pub(super) async fn list_ceo_covert_audit_access_events(
    State(state): State<ComplianceRestState>,
    headers: HeaderMap,
    Query(query): Query<AuditStreamRequest>,
) -> Result<impl IntoResponse, RestError> {
    list_ceo_covert_audit_stream(state, headers, query, AuditStreamReadKind::AccessEvents).await
}

async fn list_ceo_covert_audit_stream(
    state: ComplianceRestState,
    headers: HeaderMap,
    query: AuditStreamRequest,
    read_kind: AuditStreamReadKind,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let query = normalize_audit_stream_query(query)?;
    audit_stream_authorizer(&state, &principal, &query).await?(read_kind)?;
    let page = state
        .store
        .list_ceo_covert_audit_stream(principal.user_id, read_kind, query)
        .await
        .map_err(RestError::from_store)?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(page)))
}

fn normalize_audit_stream_query(query: AuditStreamRequest) -> Result<AuditStreamQuery, RestError> {
    let limit = query.limit.unwrap_or(100).clamp(1, 1_000);
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return Err(RestError::from_kernel(KernelError::validation(
            "offset must be non-negative",
        )));
    }
    Ok(AuditStreamQuery {
        limit,
        offset,
        purpose: "ceo_covert_audit_review".to_owned(),
        channel: "web".to_owned(),
    })
}

#[derive(Serialize)]
struct AuditStreamAvailability {
    events: bool,
    access_events: bool,
}

pub(super) async fn audit_stream_availability(
    State(state): State<ComplianceRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let query = normalize_audit_stream_query(AuditStreamRequest {
        limit: None,
        offset: None,
    })?;
    let access = audit_stream_authorizer(&state, &principal, &query).await?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(AuditStreamAvailability {
            events: access(AuditStreamReadKind::Events).is_ok(),
            access_events: access(AuditStreamReadKind::AccessEvents).is_ok(),
        }),
    ))
}

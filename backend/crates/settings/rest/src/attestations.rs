// SPDX-License-Identifier: LicenseRef-Proprietary
//! REST handlers for `/api/v1/settings/overtime-attestations`.

use crate::SettingsRestState;
use crate::error::ApiError;
use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router, routing::get};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_authz::access::{NodeKind, NodeRef};
use console_platform_request_context::{Authorization, current_audit_context};
use console_settings_adapter_postgres::{
    NewOvertimeAttestation, list_attestations, record_attestation,
};
use serde::Deserialize;
use time::Date;
use time::macros::format_description;
use uuid::Uuid;

pub const OVERTIME_ATTESTATIONS_PATH: &str = "/api/v1/settings/overtime-attestations";

pub fn routes() -> Router<SettingsRestState> {
    Router::new().route(OVERTIME_ATTESTATIONS_PATH, get(list).post(create))
}

#[derive(Debug, Default, Deserialize)]
struct AttestationQuery {
    scope_entity_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateAttestationRequest {
    #[serde(default)]
    scope_entity_id: Option<Uuid>,
    confirmed_on: String,
    rule_reference: String,
    worker_notice_method: String,
    #[serde(default)]
    statutory_basis: Option<String>,
}

async fn attestation_access(
    state: &SettingsRestState,
    principal: &Principal,
    scope_entity_id: Option<Uuid>,
) -> Result<(bool, bool), KernelError> {
    if principal.is_tenant_ops {
        return Ok((true, true));
    }
    let facts = Authorization::default()
        .load(state.store.pool(), principal)
        .await?;
    let nodes: Vec<NodeRef> = match scope_entity_id {
        None => vec![NodeRef {
            kind: NodeKind::Tenant,
            id: *principal.org_id.as_uuid(),
        }],
        Some(id) => [
            NodeKind::LegalEntity,
            NodeKind::Workplace,
            NodeKind::Department,
        ]
        .into_iter()
        .map(|kind| NodeRef { kind, id })
        .chain([NodeRef {
            kind: NodeKind::Tenant,
            id: *principal.org_id.as_uuid(),
        }])
        .collect(),
    };
    let allowed = |actions: &[&str]| -> Result<bool, KernelError> {
        for &action in actions {
            for &node in &nodes {
                if facts
                    .authorize(action, node)
                    .map_err(|e| KernelError::internal(e.to_string()))?
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    };
    Ok((
        allowed(&["settings::view", "attendance::view"])?,
        allowed(&["settings::edit", "attendance::approve"])?,
    ))
}

async fn list(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttestationQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let (can_read, can_record) =
        attestation_access(&state, &principal, query.scope_entity_id).await?;
    if !can_read {
        return Err(
            KernelError::forbidden("not authorized to view overtime rule confirmations").into(),
        );
    }
    let items =
        list_attestations(state.store.pool(), principal.org_id, query.scope_entity_id).await?;
    Ok(Json(
        serde_json::json!({ "items": items, "can_record": can_record }),
    ))
}

async fn create(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateAttestationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let audit = current_audit_context()
        .ok_or_else(|| KernelError::internal("request audit context is missing"))?;
    if !attestation_access(&state, &principal, body.scope_entity_id)
        .await?
        .1
    {
        return Err(
            KernelError::forbidden("not authorized to record overtime rule confirmations").into(),
        );
    }
    let confirmed_on = Date::parse(
        &body.confirmed_on,
        format_description!("[year]-[month]-[day]"),
    )
    .map_err(|_| {
        KernelError::validation("confirmed_on must be YYYY-MM-DD")
            .with_code("overtime_confirmed_on_invalid")
            .with_field("confirmed_on")
    })?;
    let created = record_attestation(
        state.store.pool(),
        principal.org_id,
        principal.user_id,
        NewOvertimeAttestation {
            scope_entity_id: body.scope_entity_id,
            confirmed_on,
            rule_reference: body.rule_reference,
            worker_notice_method: body.worker_notice_method,
            statutory_basis: body.statutory_basis,
        },
        (audit.trace, audit.request),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

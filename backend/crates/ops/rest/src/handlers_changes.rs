// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::changes::{CanaryDecision, ChangesService};
use console_ops_application::events::OpsEvent;
use console_ops_application::obligations::Error as SpoolError;
use console_ops_domain::changes::CmdHandOff;
use serde::{Deserialize, Serialize};

use crate::error::OpsApiError;
use crate::error_ops::{from_change_error, from_spool_error};
use crate::handlers_common::{
    NoopActionStore, eval_interval, no_store_json, no_store_status_json, op_context,
    parse_json_body,
};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct CmdResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    action: CmdHandOff,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RollbackRequest {
    digest: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanaryRequest {
    decision: CanaryDecision,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FreezeRequest {
    freeze: bool,
    reason: String,
}

pub async fn get_changes(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/changes";
    state.authorize(&headers, "read.running", ROUTE)?;
    let now = (state.clock)();
    state.refresh_vm_slot(now).await;
    let vm_slot = state.vm_slot.read().await.clone();
    let noop = NoopActionStore;
    let svc = ChangesService {
        releases: state.releases.as_deref(),
        host_state: state.host_state.as_deref(),
        actions: state.actions.as_deref().unwrap_or(&noop),
    };
    let view = svc.build_view(&vm_slot, now, eval_interval(&state));
    Ok(no_store_json(view))
}

pub async fn request_rollback(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/changes/rollback";
    let op = state.authorize(&headers, "change.request.rollback", ROUTE)?;
    let sref = (state.support_ref)();
    let req: RollbackRequest = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let svc = ChangesService {
        releases: state.releases.as_deref(),
        host_state: state.host_state.as_deref(),
        actions: action_store,
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = svc
        .request_rollback(&req.digest, &req.reason, &ctx)
        .map_err(|e| from_change_error(e, sref, ROUTE))?;
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::ActionChanged {
                id: 0,
                evaluated_at: now,
                action: handoff.clone(),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;
    Ok(no_store_status_json(
        StatusCode::CREATED,
        CmdResponse {
            evaluated_at: now,
            action: handoff,
        },
    ))
}

pub async fn request_canary(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/changes/canary";
    let base_op = state.authenticate_operator(&headers, ROUTE)?;
    let sref = (state.support_ref)();
    let req: CanaryRequest = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let cedar_action = match req.decision {
        CanaryDecision::Hold => "change.request.canary-hold",
        CanaryDecision::Promote => "change.request.canary-promote",
        CanaryDecision::Abort => "change.request.canary-abort",
    };
    let op = state.authorize_operator(&base_op, cedar_action, ROUTE)?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let svc = ChangesService {
        releases: state.releases.as_deref(),
        host_state: state.host_state.as_deref(),
        actions: action_store,
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = svc
        .request_canary(req.decision, &req.reason, &ctx)
        .map_err(|e| from_change_error(e, sref, ROUTE))?;
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::ActionChanged {
                id: 0,
                evaluated_at: now,
                action: handoff.clone(),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;
    Ok(no_store_status_json(
        StatusCode::CREATED,
        CmdResponse {
            evaluated_at: now,
            action: handoff,
        },
    ))
}

pub async fn request_freeze(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/changes/freeze";
    let base_op = state.authenticate_operator(&headers, ROUTE)?;
    let sref = (state.support_ref)();
    let req: FreezeRequest = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let cedar_action = if req.freeze {
        "change.request.freeze"
    } else {
        "change.request.unfreeze"
    };
    let op = state.authorize_operator(&base_op, cedar_action, ROUTE)?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let svc = ChangesService {
        releases: state.releases.as_deref(),
        host_state: state.host_state.as_deref(),
        actions: action_store,
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = svc
        .request_freeze(req.freeze, &req.reason, &ctx)
        .map_err(|e| from_change_error(e, sref, ROUTE))?;
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::ActionChanged {
                id: 0,
                evaluated_at: now,
                action: handoff.clone(),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;
    Ok(no_store_status_json(
        StatusCode::CREATED,
        CmdResponse {
            evaluated_at: now,
            action: handoff,
        },
    ))
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::events::OpsEvent;
use console_ops_application::obligations::Error as SpoolError;
use console_ops_application::recovery::RecoveryService;
use console_ops_application::runbooks::{RunbookError, RunbookListView};
use console_ops_domain::changes::CmdHandOff;
use console_ops_domain::recovery::{BackupRequestInput, DrillRequestInput, DrillType};
use serde::Serialize;

use crate::error::OpsApiError;
use crate::error_ops::{from_recovery_error, from_runbook_error, from_spool_error};
use crate::handlers_common::{
    NoopActionStore, effective_settings, no_store_json, no_store_status_json, op_context,
    parse_json_body,
};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct CmdResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    action: CmdHandOff,
}

pub async fn get_recovery(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/recovery";
    state.authorize(&headers, "recovery.read", ROUTE)?;
    let now = (state.clock)();
    state.refresh_vm_slot(now).await;
    let vm_slot = state.vm_slot.read().await.clone();
    let settings = effective_settings(&state);
    let noop = NoopActionStore;
    let svc = RecoveryService {
        actions: state.actions.as_deref().unwrap_or(&noop),
    };
    Ok(no_store_json(svc.build_view(&vm_slot, &settings, now)))
}

pub async fn request_backup(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/recovery/backup";
    let op = state.authorize(&headers, "change.request.backup-now", ROUTE)?;
    let sref = (state.support_ref)();
    let input: BackupRequestInput = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let svc = RecoveryService {
        actions: action_store,
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = svc
        .request_backup(&input, &ctx)
        .map_err(|e| from_recovery_error(e, sref, ROUTE))?;
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

pub async fn request_drill(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/recovery/drill";
    let base_op = state.authenticate_operator(&headers, ROUTE)?;
    let sref = (state.support_ref)();
    let input: DrillRequestInput = parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
    let cedar_action = match input.drill_type {
        DrillType::Name => "change.request.drill",
        DrillType::Time => "change.request.drill-at",
    };
    let op = state.authorize_operator(&base_op, cedar_action, ROUTE)?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let svc = RecoveryService {
        actions: action_store,
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = svc
        .request_drill(&input, &ctx)
        .map_err(|e| from_recovery_error(e, sref, ROUTE))?;
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

pub async fn list_runbooks(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/runbooks";
    state.authorize(&headers, "read.running", ROUTE)?;
    let sref = (state.support_ref)();
    let now = (state.clock)();
    state.refresh_vm_slot(now).await;
    let vm_slot = state.vm_slot.read().await.clone();
    let Some(svc) = state.runbooks_service() else {
        return Ok(no_store_json(RunbookListView {
            evaluated_at: now,
            bundle_sha: state.bundle_sha.clone(),
            deployed_sha: None,
            stale_warning: None,
            docs: Vec::new(),
        }));
    };
    let view = svc
        .list(&vm_slot, now)
        .map_err(|e| from_runbook_error(e, sref, ROUTE))?;
    Ok(no_store_json(view))
}

pub async fn read_runbook(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_rel: Result<Path<String>, PathRejection>,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/runbooks/{path}";
    state.authorize(&headers, "read.running", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(rel_path) =
        path_rel.map_err(|_| from_runbook_error(RunbookError::NotFound, sref.clone(), ROUTE))?;
    let now = (state.clock)();
    state.refresh_vm_slot(now).await;
    let vm_slot = state.vm_slot.read().await.clone();
    let svc = state
        .runbooks_service()
        .ok_or_else(|| from_runbook_error(RunbookError::NotFound, sref.clone(), ROUTE))?;
    let view = svc
        .read(&rel_path, &vm_slot, now)
        .map_err(|e| from_runbook_error(e, sref, ROUTE))?;
    Ok(no_store_json(view))
}

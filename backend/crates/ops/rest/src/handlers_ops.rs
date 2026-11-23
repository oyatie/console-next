// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::actions::{ActionRecord, ActionService};
use console_ops_application::events::OpsEvent;
use console_ops_application::health::HealthService;
use console_ops_application::obligations::Error as SpoolError;
use console_ops_application::oncall::OncallService;
use console_ops_application::recovery::rerun_job_cmd;
use console_ops_domain::Observed;
use console_ops_domain::changes::CmdHandOff;
use serde::Serialize;

use crate::error::OpsApiError;
use crate::error_ops::{from_recovery_error, from_spool_error};
use crate::handlers_common::{
    effective_settings, eval_interval, no_store_json, no_store_status_json, op_context,
    parse_json_body,
};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct CmdResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    action: CmdHandOff,
}

#[derive(Serialize)]
struct ActionsListResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    actions: Vec<ActionRecord>,
    count: Observed<usize>,
}

pub async fn get_oncall(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/oncall";
    state.authorize(&headers, "read.alerts", ROUTE)?;
    let now = (state.clock)();
    state.refresh_vm_slot(now).await;
    let vm_slot = state.vm_slot.read().await.clone();
    Ok(no_store_json(OncallService::build_view(
        state.oncall.as_ref(),
        &vm_slot,
        now,
    )))
}

pub async fn request_page_test(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/oncall/page-test";
    let op = state.authorize(&headers, "jobs.rerun", ROUTE)?;
    let sref = (state.support_ref)();
    if !body.is_empty() {
        let parsed: serde_json::Map<String, serde_json::Value> =
            parse_json_body(&body, sref.clone(), ROUTE, "bad_request")?;
        if !parsed.is_empty() {
            return Err(OpsApiError::bad_request(
                sref,
                ROUTE,
                "unexpected fields in page-test request",
            ));
        }
    }
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = OncallService::request_page_test(action_store, &ctx)
        .map_err(|e| from_spool_error(e, sref, ROUTE))?;
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

pub async fn rerun_job(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_name: Result<Path<String>, PathRejection>,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/running/jobs/{name}/rerun";
    let op = state.authorize(&headers, "jobs.rerun", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(name) =
        path_name.map_err(|_| OpsApiError::not_found(sref.clone(), ROUTE, "job not found"))?;
    let known_jobs: Vec<String> = {
        let guard = state.snapshots.read().await;
        guard
            .snapshot
            .jobs
            .jobs
            .iter()
            .map(|j| j.name.clone())
            .collect()
    };
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_spool_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let handoff = rerun_job_cmd(&known_jobs, &name, action_store, &ctx)
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

pub async fn get_health(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/health";
    state.authorize(&headers, "read.home", ROUTE)?;
    let now = (state.clock)();
    state.refresh_vm_slot(now).await;
    let vm_slot = state.vm_slot.read().await.clone();
    let status_feed = match &state.status_feed {
        Some(feed) => feed.read().await.ok(),
        None => None,
    };
    let settings = effective_settings(&state);
    let view = HealthService::build_view(&vm_slot, status_feed.as_ref(), &settings, now);
    Ok(no_store_json(view))
}

pub async fn list_actions(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/actions";
    state.authorize(&headers, "read.running", ROUTE)?;
    let now = (state.clock)();
    let interval_s = eval_interval(&state);
    let Some(store) = state.actions.as_deref() else {
        return Ok(no_store_json(ActionsListResponse {
            evaluated_at: now,
            actions: Vec::new(),
            count: Observed::unknown("actions".to_owned(), "records unreadable".to_owned()),
        }));
    };
    match ActionService::new(store).list() {
        Ok(actions) => {
            let count = Observed::current(
                actions.len(),
                Some("count".to_owned()),
                "actions".to_owned(),
                now,
                now,
                interval_s,
            );
            Ok(no_store_json(ActionsListResponse {
                evaluated_at: now,
                actions,
                count,
            }))
        }
        Err(err) => Ok(no_store_json(ActionsListResponse {
            evaluated_at: now,
            actions: Vec::new(),
            count: Observed::unknown("actions".to_owned(), err.reason()),
        })),
    }
}

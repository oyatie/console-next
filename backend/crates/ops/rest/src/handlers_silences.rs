// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::alert_actions::{
    AlertAckRecord, AlertAckStore, AlertActionsService, resolve_silence_target_severity,
};
use console_ops_application::events::OpsEvent;
use console_ops_application::obligations::{Context, Error as SpoolError};
use console_ops_domain::alert_actions::{SilenceCreateInput, validate_silence_create};
use console_ops_domain::ladders::Severity;
use serde::Serialize;

use crate::error::OpsApiError;
use crate::error_ops::from_alert_action_error;
use crate::handlers_common::{no_store_json, no_store_status_json, op_context, parse_json_body};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct SilenceCreateResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    silence_id: String,
}

#[derive(Serialize)]
struct SilenceDeleteResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    silence_id: String,
    deleted: bool,
}

struct DummyAckStore;
impl AlertAckStore for DummyAckStore {
    fn list_acks(&self) -> Result<Vec<AlertAckRecord>, SpoolError> {
        Ok(Vec::new())
    }
    fn record_ack(
        &self,
        _group_key: &str,
        _alertname: &str,
        _component: &str,
        _note: Option<String>,
        _context: &Context,
    ) -> Result<AlertAckRecord, SpoolError> {
        Err(SpoolError::WriteFailed)
    }
}

pub async fn create_silence(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/silences";
    let op = state.authorize(&headers, "alert.silence", ROUTE)?;
    let sref = (state.support_ref)();
    let input: SilenceCreateInput =
        parse_json_body(&body, sref.clone(), ROUTE, "OPS_SILENCE_INVALID")?;

    let now = (state.clock)();
    validate_silence_create(&input, Some(Severity::Ticket), now)
        .map_err(|e| from_alert_action_error(e.into(), sref.clone(), ROUTE))?;
    let (groups, alert_details) = {
        let guard = state.snapshots.read().await;
        (
            guard.snapshot.alerts.clone(),
            guard.snapshot.alert_details.clone(),
        )
    };
    let target_sev = resolve_silence_target_severity(&input, &groups, Some(&alert_details))
        .map_err(|e| from_alert_action_error(e.into(), sref.clone(), ROUTE))?;
    validate_silence_create(&input, Some(target_sev), now)
        .map_err(|e| from_alert_action_error(e.into(), sref.clone(), ROUTE))?;

    let silence_store = state.silence_store.as_deref().ok_or_else(|| {
        OpsApiError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "OPS_RECORD_WRITE_FAILED",
            sref.clone(),
            ROUTE,
            "silences spool not configured",
        )
    })?;
    let am_writer = state.am_writer.as_deref().ok_or_else(|| {
        OpsApiError::with_code(
            StatusCode::BAD_GATEWAY,
            "OPS_UPSTREAM_FAILED",
            sref.clone(),
            ROUTE,
            "alertmanager writer not configured",
        )
    })?;

    let dummy_ack = DummyAckStore;
    let ack_ref = state.ack_store.as_deref().unwrap_or(&dummy_ack);
    let svc = AlertActionsService {
        ack_store: ack_ref,
        silence_store,
        am_writer,
    };
    let ctx = op_context(&op, now, sref.clone());
    let silence_id = svc
        .create_silence_with_details(&input, &groups, Some(&alert_details), &ctx)
        .await
        .map_err(|e| from_alert_action_error(e, sref, ROUTE))?;

    let (group_ev, home_snap) = {
        let guard = state.snapshots.read().await;
        let g = input
            .group_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|k| guard.snapshot.alert_details.get(k).cloned());
        (g, guard.snapshot.home.clone())
    };
    let mut events = vec![OpsEvent::SilenceChanged {
        id: 0,
        evaluated_at: now,
        silence_id: silence_id.clone(),
        active: true,
    }];
    if let Some(group) = group_ev {
        events.push(OpsEvent::AlertGroupChanged {
            id: 0,
            evaluated_at: now,
            group,
        });
    }
    events.push(OpsEvent::HomeChanged {
        id: 0,
        evaluated_at: now,
        home: home_snap,
    });
    state.emit_events(events).await;

    Ok(no_store_status_json(
        StatusCode::CREATED,
        SilenceCreateResponse {
            evaluated_at: now,
            silence_id,
        },
    ))
}

pub async fn delete_silence(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_id: Result<Path<String>, PathRejection>,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/silences/{id}";
    let op = state.authorize(&headers, "alert.silence", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(id) =
        path_id.map_err(|_| OpsApiError::not_found(sref.clone(), ROUTE, "silence not found"))?;

    let silence_store = state.silence_store.as_deref().ok_or_else(|| {
        OpsApiError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "OPS_RECORD_WRITE_FAILED",
            sref.clone(),
            ROUTE,
            "silences spool not configured",
        )
    })?;
    let am_writer = state.am_writer.as_deref().ok_or_else(|| {
        OpsApiError::with_code(
            StatusCode::BAD_GATEWAY,
            "OPS_UPSTREAM_FAILED",
            sref.clone(),
            ROUTE,
            "alertmanager writer not configured",
        )
    })?;

    let dummy_ack = DummyAckStore;
    let ack_ref = state.ack_store.as_deref().unwrap_or(&dummy_ack);
    let svc = AlertActionsService {
        ack_store: ack_ref,
        silence_store,
        am_writer,
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    svc.delete_silence(&id, &ctx)
        .await
        .map_err(|e| from_alert_action_error(e, sref, ROUTE))?;

    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::SilenceChanged {
                id: 0,
                evaluated_at: now,
                silence_id: id.clone(),
                active: false,
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;

    Ok(no_store_json(SilenceDeleteResponse {
        evaluated_at: now,
        silence_id: id,
        deleted: true,
    }))
}

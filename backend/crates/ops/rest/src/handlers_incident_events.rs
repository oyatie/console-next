// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::events::OpsEvent;
use console_ops_application::incidents::{
    IncidentDetailView, IncidentSummaryView, IncidentsService,
};
use console_ops_application::obligations::Error as SpoolError;
use console_ops_domain::incident::{IncidentEvent, PublicDraftStage, PublicUpdateDraft};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::OpsApiError;
use crate::error_ops::from_incident_error;
use crate::handlers_common::{
    NoopActionStore, no_store_json, no_store_status_json, op_context, parse_json_body,
};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct IncidentResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    incident: IncidentDetailView,
}

#[derive(Serialize)]
struct PublicDraftResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    incident: IncidentDetailView,
    action: console_ops_domain::changes::CmdHandOff,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicDraftRequest {
    #[serde(default, alias = "prev")]
    expected_seq: Option<u64>,
    stage: PublicDraftStage,
    components: Vec<String>,
    message_ko: String,
    message_en: String,
    rev: u64,
}

fn parse_incident_event_body(
    bytes: &[u8],
    support_ref: String,
    route: &'static str,
) -> Result<(u64, IncidentEvent), OpsApiError> {
    let mut obj: Map<String, Value> =
        parse_json_body(bytes, support_ref.clone(), route, "OPS_INCIDENT_INVALID")?;
    let seq_val = obj.remove("expected_seq");
    let prev_val = obj.remove("prev");
    let expected_seq = match (seq_val, prev_val) {
        (Some(v), None) | (None, Some(v)) => v.as_u64(),
        (Some(a), Some(b)) if a == b => a.as_u64(),
        _ => None,
    }
    .filter(|&seq| seq >= 1)
    .ok_or_else(|| {
        OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            "OPS_INCIDENT_INVALID",
            support_ref.clone(),
            route,
            "expected_seq or prev integer >= 1 is required",
        )
    })?;
    let event: IncidentEvent = serde_json::from_value(Value::Object(obj)).map_err(|err| {
        OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            "OPS_INCIDENT_INVALID",
            support_ref.clone(),
            route,
            format!("invalid incident event: {err}"),
        )
    })?;
    if matches!(
        event,
        IncidentEvent::Declared { .. } | IncidentEvent::PublicDrafted { .. }
    ) {
        return Err(OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            "OPS_INCIDENT_INVALID",
            support_ref,
            route,
            "event type is not allowed on this endpoint",
        ));
    }
    Ok((expected_seq, event))
}

pub async fn record_incident_event(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_id: Result<Path<String>, PathRejection>,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/incidents/{id}/events";
    let op = state.authorize(&headers, "incident.write", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(id) =
        path_id.map_err(|_| OpsApiError::not_found(sref.clone(), ROUTE, "incident not found"))?;
    let (expected_seq, event) = parse_incident_event_body(&body, sref.clone(), ROUTE)?;
    let inc_store = state
        .incidents
        .as_deref()
        .ok_or_else(|| from_incident_error(SpoolError::WriteFailed.into(), sref.clone(), ROUTE))?;
    let noop = NoopActionStore;
    let svc = IncidentsService {
        incidents: inc_store,
        actions: state.actions.as_deref().unwrap_or(&noop),
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let updated = svc
        .mutate(&id, expected_seq, event, &ctx)
        .map_err(|e| from_incident_error(e, sref, ROUTE))?;
    let detail = IncidentDetailView {
        legal_clocks: updated.legal_clocks(now),
        public_card: None,
        state: updated.clone(),
    };
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::IncidentChanged {
                id: 0,
                evaluated_at: now,
                incident: IncidentSummaryView::from_state(&updated, now),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;
    Ok(no_store_json(IncidentResponse {
        evaluated_at: now,
        incident: detail,
    }))
}

pub async fn draft_public_update(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_id: Result<Path<String>, PathRejection>,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/incidents/{id}/public-draft";
    let op = state.authorize(&headers, "incident.publish", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(id) =
        path_id.map_err(|_| OpsApiError::not_found(sref.clone(), ROUTE, "incident not found"))?;
    let req: PublicDraftRequest =
        parse_json_body(&body, sref.clone(), ROUTE, "OPS_INCIDENT_INVALID")?;
    let inc_store = state
        .incidents
        .as_deref()
        .ok_or_else(|| from_incident_error(SpoolError::WriteFailed.into(), sref.clone(), ROUTE))?;
    let action_store = state
        .actions
        .as_deref()
        .ok_or_else(|| from_incident_error(SpoolError::WriteFailed.into(), sref.clone(), ROUTE))?;
    let svc = IncidentsService {
        incidents: inc_store,
        actions: action_store,
    };
    let expected_seq = match req.expected_seq {
        Some(seq) => seq,
        None => {
            inc_store
                .get(&id)
                .map_err(|e| from_incident_error(e, sref.clone(), ROUTE))?
                .head_seq
        }
    };
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let draft = PublicUpdateDraft {
        stage: req.stage,
        components: req.components,
        message_ko: req.message_ko,
        message_en: req.message_en,
        rev: req.rev,
    };
    let (updated, handoff) = svc
        .draft_public_update(&id, expected_seq, draft, &ctx)
        .map_err(|e| from_incident_error(e, sref, ROUTE))?;
    let detail = IncidentDetailView {
        legal_clocks: updated.legal_clocks(now),
        public_card: None,
        state: updated.clone(),
    };
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::IncidentChanged {
                id: 0,
                evaluated_at: now,
                incident: IncidentSummaryView::from_state(&updated, now),
            },
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
        PublicDraftResponse {
            evaluated_at: now,
            incident: detail,
            action: handoff,
        },
    ))
}

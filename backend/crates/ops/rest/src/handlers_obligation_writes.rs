// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::events::OpsEvent;
use console_ops_application::obligations::{Error as SpoolError, ObligationItemView, Record};
use console_ops_domain::obligation::{Event, Kind, ReviewerRole};
use serde::{Deserialize, Serialize};
use time::Date;

use crate::error::OpsApiError;
use crate::error_ops::from_obligation_error;
use crate::handlers_common::{no_store_json, no_store_status_json, op_context, parse_json_body};
use crate::state::OpsRestState;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenObligationRequest {
    kind: Kind,
    reviewer_role: ReviewerRole,
    title: String,
    #[serde(default, with = "iso_date::option")]
    due: Option<Date>,
    #[serde(default)]
    evidence_ref: Option<String>,
}

#[derive(Serialize)]
struct ObligationWriteResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    id: String,
    item: ObligationItemView,
    record: Record,
}

pub async fn open_obligation(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/obligations";
    let op = state.authorize(&headers, "obligation.write", ROUTE)?;
    let sref = (state.support_ref)();
    let req: OpenObligationRequest =
        parse_json_body(&body, sref.clone(), ROUTE, "OPS_OBLIGATION_INVALID")?;
    let store = state
        .obligations
        .as_deref()
        .ok_or_else(|| from_obligation_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let event = Event::Opened {
        kind: req.kind,
        reviewer_role: req.reviewer_role,
        title: req.title,
        due: req.due,
        evidence_ref: req.evidence_ref,
    };
    let (item, record) = store
        .open(event, &ctx)
        .map_err(|e| from_obligation_error(e, sref, ROUTE))?;
    let id = item.id.clone();
    let item_view = ObligationItemView::from_item(item, now);
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::ObligationChanged {
                id: 0,
                evaluated_at: now,
                item: item_view.clone(),
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
        ObligationWriteResponse {
            evaluated_at: now,
            id,
            item: item_view,
            record,
        },
    ))
}

pub async fn record_obligation_event(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_id: Result<Path<String>, PathRejection>,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/obligations/{id}/events";
    let op = state.authorize(&headers, "obligation.write", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(id) = path_id.map_err(|_| {
        OpsApiError::with_code(
            StatusCode::NOT_FOUND,
            "OPS_OBLIGATION_NOT_FOUND",
            sref.clone(),
            ROUTE,
            "obligation not found",
        )
    })?;
    let event: Event = parse_json_body(&body, sref.clone(), ROUTE, "OPS_OBLIGATION_INVALID")?;
    let store = state
        .obligations
        .as_deref()
        .ok_or_else(|| from_obligation_error(SpoolError::WriteFailed, sref.clone(), ROUTE))?;
    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let (item, record) = store
        .event(&id, event, &ctx)
        .map_err(|e| from_obligation_error(e, sref, ROUTE))?;
    let item_view = ObligationItemView::from_item(item, now);
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::ObligationChanged {
                id: 0,
                evaluated_at: now,
                item: item_view.clone(),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;
    Ok(no_store_json(ObligationWriteResponse {
        evaluated_at: now,
        id,
        item: item_view,
        record,
    }))
}

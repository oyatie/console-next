// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use axum::body::Bytes;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::alert_actions::{AlertAckRecord, overlay_acks_and_changes};
use console_ops_application::events::OpsEvent;
use console_ops_application::snapshot::SourceKind;
use console_ops_domain::alert_actions::{AlertAckPayload, validate_alert_ack_note};
use serde::Serialize;

use crate::error::OpsApiError;
use crate::error_ops::from_spool_error;
use crate::handlers_common::{no_store_json, op_context, parse_json_body};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct AckResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    record: AlertAckRecord,
    group: console_ops_application::snapshot::AlertGroupDetailView,
}

pub async fn ack_alert(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_key: Result<Path<String>, PathRejection>,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/alerts/{key}/ack";
    let op = state.authorize(&headers, "alert.ack", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(key) = path_key
        .map_err(|_| OpsApiError::not_found(sref.clone(), ROUTE, "alert group not found"))?;
    let payload: AlertAckPayload = if body.is_empty() {
        AlertAckPayload { note: None }
    } else {
        parse_json_body(&body, sref.clone(), ROUTE, "OPS_ALERT_ACK_INVALID")?
    };
    let clean_note = validate_alert_ack_note(payload.note.as_deref()).map_err(|_| {
        OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            "OPS_ALERT_ACK_INVALID",
            sref.clone(),
            ROUTE,
            "invalid alert acknowledgement note",
        )
    })?;

    let detail = {
        let guard = state.snapshots.read().await;
        guard.snapshot.alert_details.get(&key).cloned()
    }
    .ok_or_else(|| OpsApiError::not_found(sref.clone(), ROUTE, "alert group not found"))?;

    let ack_store = state.ack_store.as_deref().ok_or_else(|| {
        OpsApiError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "OPS_RECORD_WRITE_FAILED",
            sref.clone(),
            ROUTE,
            "records spool not configured",
        )
    })?;

    let now = (state.clock)();
    let ctx = op_context(&op, now, sref.clone());
    let component = detail
        .summary_group
        .component
        .value()
        .cloned()
        .unwrap_or_default();
    let record = ack_store
        .record_ack(
            &detail.summary_group.key,
            &detail.summary_group.alertname,
            &component,
            clean_note,
            &ctx,
        )
        .map_err(|e| from_spool_error(e, sref, ROUTE))?;

    let (updated_group, home_snap) = {
        let mut guard = state.snapshots.write().await;
        let am_interval = guard
            .snapshot
            .sources
            .sources
            .iter()
            .find(|s| s.kind == SourceKind::Alertmanager)
            .and_then(|s| NonZeroU64::new(s.interval))
            .unwrap_or(NonZeroU64::MIN);
        let snap = &mut guard.snapshot;
        overlay_acks_and_changes(
            &mut snap.alerts,
            &mut snap.alert_details,
            std::slice::from_ref(&record),
            &[],
            now,
            am_interval,
        );
        let updated = snap.alert_details.get(&key).cloned().unwrap_or(detail);
        if let Some(item) = snap
            .home
            .worklist
            .iter_mut()
            .find(|w| w.next.href == format!("/alerts/{key}"))
        {
            item.lead = updated.summary_group.lead.clone();
        }
        (updated, snap.home.clone())
    };

    state
        .emit_events(vec![
            OpsEvent::AlertGroupChanged {
                id: 0,
                evaluated_at: now,
                group: updated_group.clone(),
            },
            OpsEvent::HomeChanged {
                id: 0,
                evaluated_at: now,
                home: home_snap,
            },
        ])
        .await;

    Ok(no_store_json(AckResponse {
        evaluated_at: now,
        record,
        group: updated_group,
    }))
}

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
use console_ops_domain::incident::{IncidentEvent, PersonalDataImpact};
use console_ops_domain::ladders::IncidentSeverity;
use console_ops_domain::{Observed, UtcTimestamp};
use serde::{Deserialize, Serialize};

use crate::error::OpsApiError;
use crate::error_ops::from_incident_error;
use crate::handlers_common::{
    NoopActionStore, eval_interval, no_store_json, no_store_status_json, op_context,
    parse_json_body,
};
use crate::state::OpsRestState;

#[derive(Serialize)]
struct IncidentsListResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    incidents: Vec<IncidentSummaryView>,
    count: Observed<usize>,
}

#[derive(Serialize)]
struct IncidentResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    incident: IncidentDetailView,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclareIncidentRequest {
    title: String,
    sev: IncidentSeverity,
    #[serde(default)]
    lead: Option<String>,
    #[serde(default)]
    affected_components: Vec<String>,
    personal_data_impact: PersonalDataImpact,
    #[serde(default)]
    intrusion: bool,
    discovered_at: UtcTimestamp,
    #[serde(default)]
    next_public_update_at: Option<UtcTimestamp>,
    #[serde(default)]
    public_incident_id: Option<String>,
}

pub async fn list_incidents(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/incidents";
    state.authorize(&headers, "read.home", ROUTE)?;
    let now = (state.clock)();
    let interval_s = eval_interval(&state);
    let Some(inc_store) = state.incidents.as_deref() else {
        return Ok(no_store_json(IncidentsListResponse {
            evaluated_at: now,
            incidents: Vec::new(),
            count: Observed::unknown("incidents".to_owned(), "records unreadable".to_owned()),
        }));
    };
    let noop = NoopActionStore;
    let svc = IncidentsService {
        incidents: inc_store,
        actions: state.actions.as_deref().unwrap_or(&noop),
    };
    match svc.list() {
        Ok(list) => {
            let summaries: Vec<_> = list
                .iter()
                .map(|s| IncidentSummaryView::from_state(s, now))
                .collect();
            let count = Observed::current(
                summaries.len(),
                Some("count".to_owned()),
                "incidents".to_owned(),
                now,
                now,
                interval_s,
            );
            Ok(no_store_json(IncidentsListResponse {
                evaluated_at: now,
                incidents: summaries,
                count,
            }))
        }
        Err(err) => {
            let reason = match &err {
                console_ops_application::incidents::IncidentError::Spool(e) => e.reason(),
                _ => err.code().to_owned(),
            };
            Ok(no_store_json(IncidentsListResponse {
                evaluated_at: now,
                incidents: Vec::new(),
                count: Observed::unknown("incidents".to_owned(), reason),
            }))
        }
    }
}

pub async fn declare_incident(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/incidents";
    let op = state.authorize(&headers, "incident.write", ROUTE)?;
    let sref = (state.support_ref)();
    let req: DeclareIncidentRequest =
        parse_json_body(&body, sref.clone(), ROUTE, "OPS_INCIDENT_INVALID")?;
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
    let event = IncidentEvent::Declared {
        title: req.title,
        sev: req.sev,
        lead: req.lead,
        affected_components: req.affected_components,
        personal_data_impact: req.personal_data_impact,
        intrusion: req.intrusion,
        discovered_at: req.discovered_at,
        next_public_update_at: req.next_public_update_at,
        public_incident_id: req.public_incident_id,
    };
    let created = svc
        .declare(event, &ctx)
        .map_err(|e| from_incident_error(e, sref, ROUTE))?;
    let detail = IncidentDetailView {
        legal_clocks: created.legal_clocks(now),
        public_card: None,
        state: created.clone(),
    };
    let home_snap = state.snapshots.read().await.snapshot.home.clone();
    state
        .emit_events(vec![
            OpsEvent::IncidentChanged {
                id: 0,
                evaluated_at: now,
                incident: IncidentSummaryView::from_state(&created, now),
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
        IncidentResponse {
            evaluated_at: now,
            incident: detail,
        },
    ))
}

pub async fn incident_detail(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_id: Result<Path<String>, PathRejection>,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/incidents/{id}";
    state.authorize(&headers, "read.home", ROUTE)?;
    let sref = (state.support_ref)();
    let Path(id) =
        path_id.map_err(|_| OpsApiError::not_found(sref.clone(), ROUTE, "incident not found"))?;
    let inc_store = state
        .incidents
        .as_deref()
        .ok_or_else(|| from_incident_error(SpoolError::Unreadable.into(), sref.clone(), ROUTE))?;
    let public_incidents = match &state.status_feed {
        Some(feed) => feed
            .read()
            .await
            .ok()
            .map(|s| s.incidents)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let noop = NoopActionStore;
    let svc = IncidentsService {
        incidents: inc_store,
        actions: state.actions.as_deref().unwrap_or(&noop),
    };
    let now = (state.clock)();
    let detail = svc
        .detail(&id, &public_incidents, now)
        .map_err(|e| from_incident_error(e, sref, ROUTE))?;
    Ok(no_store_json(IncidentResponse {
        evaluated_at: now,
        incident: detail,
    }))
}

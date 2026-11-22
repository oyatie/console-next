// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use axum::Json;
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use console_ops_application::snapshot::{
    AlertDetailView, AlertGroupsView, GrantView, HomeSnapshotView, JobsView, MeView, OperatorView,
    RunningView, SilencesView, SourceKind, SourcesView,
};
use console_ops_domain::Observed;
use console_ops_domain::ladders::{AlertState, EvidenceState, Health, Severity};
use serde::Deserialize;

use crate::error::OpsApiError;
use crate::state::OpsRestState;

const STAGE0_ACTIONS: [&str; 5] = [
    "read.me",
    "read.home",
    "read.alerts",
    "read.running",
    "read.sources",
];

fn no_store_json<T: serde::Serialize>(value: T) -> Response {
    let mut resp = Json(value).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub async fn get_me(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    let op = state.authorize(&headers, "read.me", "/api/ops/v1/me")?;
    let now = (state.clock)();
    let allowed_actions: Vec<String> = STAGE0_ACTIONS
        .iter()
        .filter(|&&action| state.is_action_allowed(&op.display_email, action, now))
        .map(|&s| s.to_owned())
        .collect();
    let grants = op
        .grants
        .into_iter()
        .map(|g| GrantView {
            action: g.action,
            from: g.from,
            until: g.until,
        })
        .collect();
    Ok(no_store_json(MeView {
        evaluated_at: now,
        operator: OperatorView {
            person: op.person.to_string(),
            display_email: op.display_email,
        },
        grants,
        allowed_actions,
    }))
}

pub async fn get_home(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.home", "/api/ops/v1/home")?;
    let home: HomeSnapshotView = state.snapshots.read().await.snapshot.home.clone();
    Ok(no_store_json(home))
}

#[derive(Debug, Deserialize)]
pub struct AlertsQuery {
    pub state: Option<AlertState>,
    pub severity: Option<Severity>,
    pub component: Option<String>,
}

pub async fn get_alerts(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    query: Result<Query<AlertsQuery>, QueryRejection>,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.alerts", "/api/ops/v1/alerts")?;
    let Query(query) = query.map_err(|_| {
        OpsApiError::bad_request(
            (state.support_ref)(),
            "/api/ops/v1/alerts",
            "invalid query parameters",
        )
    })?;
    let guard = state.snapshots.read().await;
    let am_interval = guard
        .snapshot
        .sources
        .sources
        .iter()
        .find(|s| s.kind == SourceKind::Alertmanager)
        .and_then(|s| NonZeroU64::new(s.interval))
        .unwrap_or(NonZeroU64::MIN);
    let mut alerts: AlertGroupsView = guard.snapshot.alerts.clone();
    drop(guard);
    let filtered = query.state.is_some() || query.severity.is_some() || query.component.is_some();
    if filtered {
        alerts.groups.retain(|g| {
            query
                .state
                .is_none_or(|want| g.state.value() == Some(&want))
                && query
                    .severity
                    .is_none_or(|want| g.severity.value() == Some(&want))
                && query
                    .component
                    .as_deref()
                    .is_none_or(|want| g.component.value().map(String::as_str) == Some(want))
        });
        if alerts.count.state() == EvidenceState::Verified {
            let group_n = alerts.groups.len();
            let member_n: usize = alerts
                .groups
                .iter()
                .filter_map(|g| g.members_n.value().copied())
                .sum();
            let src = alerts.count.source().to_owned();
            let unit = alerts.count.unit().map(str::to_owned);
            let now = (state.clock)();
            if let Some(obs_at) = alerts.count.observed_at() {
                alerts.count =
                    Observed::current(group_n, unit.clone(), src.clone(), obs_at, now, am_interval);
                alerts.alert_count =
                    Observed::current(member_n, unit, src, obs_at, now, am_interval);
            }
        }
    }
    Ok(no_store_json(alerts))
}

pub async fn get_alert_detail(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_key: Result<Path<String>, PathRejection>,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.alerts", "/api/ops/v1/alerts/{key}")?;
    let Path(key) = path_key.map_err(|_| {
        OpsApiError::not_found(
            (state.support_ref)(),
            "/api/ops/v1/alerts/{key}",
            "alert group not found",
        )
    })?;
    let guard = state.snapshots.read().await;
    let group = guard
        .snapshot
        .alert_details
        .get(&key)
        .cloned()
        .ok_or_else(|| {
            OpsApiError::not_found(
                (state.support_ref)(),
                "/api/ops/v1/alerts/{key}",
                "alert group not found",
            )
        })?;
    Ok(no_store_json(AlertDetailView {
        evaluated_at: guard.snapshot.evaluated_at,
        group,
    }))
}

pub async fn get_silences(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.alerts", "/api/ops/v1/silences")?;
    let silences: SilencesView = state.snapshots.read().await.snapshot.silences.clone();
    Ok(no_store_json(silences))
}

#[derive(Debug, Deserialize)]
pub struct RunningQuery {
    pub group: Option<String>,
    pub state: Option<Health>,
}

pub async fn get_running(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    query: Result<Query<RunningQuery>, QueryRejection>,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.running", "/api/ops/v1/running")?;
    let Query(query) = query.map_err(|_| {
        OpsApiError::bad_request(
            (state.support_ref)(),
            "/api/ops/v1/running",
            "invalid query parameters",
        )
    })?;
    let guard = state.snapshots.read().await;
    let vm_interval = guard
        .snapshot
        .sources
        .sources
        .iter()
        .find(|s| s.kind == SourceKind::VictoriaMetrics)
        .and_then(|s| NonZeroU64::new(s.interval))
        .unwrap_or(NonZeroU64::MIN);
    let mut running: RunningView = guard.snapshot.running.clone();
    drop(guard);
    let filtered = query.group.is_some() || query.state.is_some();
    if filtered {
        running.components.retain(|c| {
            query.group.as_deref().is_none_or(|want| c.group == want)
                && query
                    .state
                    .is_none_or(|want| c.health.value() == Some(&want))
        });
        if running.count.state() == EvidenceState::Verified
            && let Some(obs_at) = running.count.observed_at()
        {
            running.count = Observed::current(
                running.components.len(),
                running.count.unit().map(str::to_owned),
                running.count.source().to_owned(),
                obs_at,
                (state.clock)(),
                vm_interval,
            );
        }
    }
    Ok(no_store_json(running))
}

pub async fn get_jobs(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.running", "/api/ops/v1/running/jobs")?;
    let jobs: JobsView = state.snapshots.read().await.snapshot.jobs.clone();
    Ok(no_store_json(jobs))
}

pub async fn get_sources(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
) -> Result<Response, OpsApiError> {
    state.authorize(&headers, "read.sources", "/api/ops/v1/sources")?;
    let sources: SourcesView = state.snapshots.read().await.snapshot.sources.clone();
    Ok(no_store_json(sources))
}

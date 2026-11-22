// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use console_ops_application::actions::{ActionRecord, ActionStore, CmdHandOffInput};
use console_ops_application::home_worklist::{
    build_action_home_worklist, build_incident_home_worklist, build_obligation_home_parts,
};
use console_ops_application::incidents::IncidentSummaryView;
use console_ops_application::obligations::{Context, Error as SpoolError, Operator};
use console_ops_application::snapshot::{HomeSnapshotView, RunningView, SourceView};
use console_ops_domain::bundle::{
    AccessSettings, OpsSettings, ReadLimitsSettings, SourceEndpointSettings, SourceSettings,
};
use console_ops_domain::ladders::{EvidenceState, Health, WorkKind};
use console_ops_domain::{roll_up, verdict};
use serde::Serialize;
use serde::de::DeserializeOwned;
use time::OffsetDateTime;

use crate::error::OpsApiError;
use crate::state::{AuthorizedOperator, OpsRestState};

pub(crate) fn no_store_json<T: Serialize>(value: T) -> Response {
    no_store_status_json(StatusCode::OK, value)
}

pub(crate) fn no_store_status_json<T: Serialize>(status: StatusCode, value: T) -> Response {
    let mut resp = (status, Json(value)).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub(crate) fn parse_json_body<T: DeserializeOwned>(
    bytes: &[u8],
    support_ref: String,
    route: &'static str,
    code: &'static str,
) -> Result<T, OpsApiError> {
    serde_json::from_slice(bytes).map_err(|err| {
        OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            code,
            support_ref,
            route,
            format!("invalid request body: {err}"),
        )
    })
}

pub(crate) fn op_context(
    op: &AuthorizedOperator,
    now: OffsetDateTime,
    support_ref: String,
) -> Context {
    Context {
        at: now,
        operator: Operator {
            person: op.person.to_string(),
            method: "access-jwt".to_owned(),
        },
        support_ref,
    }
}

pub(crate) fn eval_interval(state: &OpsRestState) -> NonZeroU64 {
    state
        .settings
        .as_ref()
        .and_then(|s| s.budgets.get("evaluate_interval_s").copied())
        .or_else(|| NonZeroU64::new(15))
        .unwrap_or(NonZeroU64::MIN)
}

pub(crate) fn effective_settings(state: &OpsRestState) -> OpsSettings {
    if let Some(settings) = &state.settings {
        return settings.clone();
    }
    let interval = NonZeroU64::new(15).unwrap_or(NonZeroU64::MIN);
    let ep = SourceEndpointSettings {
        url: "http://localhost".to_owned(),
        producer: "victoriametrics".to_owned(),
        interval_s: interval,
        read_limits: ReadLimitsSettings {
            request_timeout_ms: NonZeroU64::new(1000).unwrap_or(NonZeroU64::MIN),
            max_response_bytes: NonZeroU64::new(1024).unwrap_or(NonZeroU64::MIN),
        },
    };
    OpsSettings {
        sources: SourceSettings {
            alertmanager: ep.clone(),
            vmalert: ep.clone(),
            victoriametrics: ep,
        },
        access: AccessSettings {
            team: "default".to_owned(),
            aud: "default".to_owned(),
            issuer: "https://example.invalid".to_owned(),
            jwks: "/dev/null".to_owned(),
            interval_s: interval,
        },
        origin: state.origin.to_string(),
        thresholds: BTreeMap::new(),
        budgets: BTreeMap::new(),
        records: None,
        obligations: None,
    }
}

pub(crate) struct NoopActionStore;

impl ActionStore for NoopActionStore {
    fn list_actions(&self) -> Result<Vec<ActionRecord>, SpoolError> {
        Ok(Vec::new())
    }

    fn record_handoff(
        &self,
        _input: &CmdHandOffInput<'_>,
        _context: &Context,
    ) -> Result<ActionRecord, SpoolError> {
        Err(SpoolError::WriteFailed)
    }
}

pub(crate) fn enrich_home_snapshot(
    state: &OpsRestState,
    op: &AuthorizedOperator,
    now: OffsetDateTime,
    interval_s: NonZeroU64,
    home: &mut HomeSnapshotView,
    running: &RunningView,
    base_sources: Vec<SourceView>,
) {
    let mut added_extra = false;
    let mut all_sources = base_sources;

    if let Some(inc_store) = &state.incidents
        && let Ok(list) = inc_store.list()
    {
        let opened_at_map: BTreeMap<String, OffsetDateTime> =
            list.iter().map(|s| (s.id.clone(), *s.opened_at)).collect();
        let summaries: Vec<IncidentSummaryView> = list
            .iter()
            .map(|s| IncidentSummaryView::from_state(s, now))
            .collect();
        let inc_items = build_incident_home_worklist(&summaries, &opened_at_map, now, interval_s);
        if !inc_items.is_empty() {
            added_extra = true;
            home.worklist.extend(inc_items);
        }
    }

    if state.is_action_allowed(&op.display_email, "read.running", now)
        && let Some(action_store) = &state.actions
        && let Ok(actions) = action_store.list_actions()
    {
        let action_items = build_action_home_worklist(&actions, now, interval_s);
        if !action_items.is_empty() {
            added_extra = true;
            home.worklist.extend(action_items);
        }
    }

    if state.is_action_allowed(&op.display_email, "obligation.read", now)
        && let Some(ob_store) = &state.obligations
    {
        added_extra = true;
        let snap_res = ob_store.snapshot();
        let (readiness, ob_items, ob_source) = match &snap_res {
            Ok((items, records)) => build_obligation_home_parts(
                Ok((items.as_slice(), records.as_slice())),
                now,
                state.due_soon_days,
                interval_s,
            ),
            Err(err) => {
                build_obligation_home_parts(Err(err.clone()), now, state.due_soon_days, interval_s)
            }
        };
        home.launch_readiness = Some(readiness);
        home.worklist.extend(ob_items);
        match ob_source.state {
            EvidenceState::Verified => home.evidence.counts.verified += 1,
            EvidenceState::Monitoring => home.evidence.counts.monitoring += 1,
            EvidenceState::Stale => home.evidence.counts.stale += 1,
            EvidenceState::Unknown => {
                home.evidence.counts.unknown += 1;
                home.evidence.sources.push(ob_source.clone());
            }
        }
        all_sources.push(ob_source);
    }

    if added_extra {
        home.worklist.sort_by_key(|w| w.kind);
        let work_kinds: Vec<WorkKind> = home.worklist.iter().map(|w| w.kind).collect();
        let worst_health = if running.components.is_empty() {
            Health::Healthy
        } else {
            roll_up(
                running
                    .components
                    .iter()
                    .map(|c| c.health.value().copied().unwrap_or(Health::Unknown)),
            )
        };
        let evidence_pairs: Vec<(EvidenceState, Option<&str>)> = all_sources
            .iter()
            .map(|s| (s.state, s.reason.as_deref()))
            .collect();
        home.verdict = verdict(worst_health, &work_kinds, &evidence_pairs);
    }
}

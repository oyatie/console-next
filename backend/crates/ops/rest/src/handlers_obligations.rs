// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use console_ops_application::obligations::{Error as SpoolError, ObligationItemView, Record};
use console_ops_application::snapshot::{SourceKind, SourceView};
use console_ops_domain::ladders::{EvidenceState, Health};
use console_ops_domain::obligation::{Kind, Obligation, State as ObState, launch_readiness};
use console_ops_domain::{Observed, Verdict};
use serde::{Deserialize, Serialize};

use crate::error::OpsApiError;
use crate::error_ops::from_obligation_error;
use crate::handlers_common::{eval_interval, no_store_json};
use crate::state::OpsRestState;

#[derive(Debug, Deserialize)]
pub struct ObligationsQuery {
    pub kind: Option<Kind>,
    pub state: Option<ObState>,
}

#[derive(Serialize)]
struct ObligationsListResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    verdict: Verdict,
    launch_readiness: Verdict,
    items: Vec<ObligationItemView>,
    count: Observed<usize>,
    sources: Vec<SourceView>,
}

#[derive(Serialize)]
struct ObligationDetailResponse {
    #[serde(with = "time::serde::rfc3339")]
    evaluated_at: time::OffsetDateTime,
    verdict: Verdict,
    item: Option<ObligationItemView>,
    history: Vec<Record>,
    sources: Vec<SourceView>,
}

fn unknown_source(reason: String, interval: u64) -> SourceView {
    SourceView {
        name: "obligations".to_owned(),
        kind: SourceKind::Obligations,
        producer: "ops-records".to_owned(),
        interval,
        observed_at: None,
        age: 0,
        state: EvidenceState::Unknown,
        reason: Some(reason),
    }
}

pub async fn list_obligations(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    query: Result<Query<ObligationsQuery>, QueryRejection>,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/obligations";
    state.authorize(&headers, "obligation.read", ROUTE)?;
    let sref = (state.support_ref)();
    let Query(query) = query.map_err(|_| {
        OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            "OPS_OBLIGATION_INVALID",
            sref,
            ROUTE,
            "invalid query parameters",
        )
    })?;
    let now = (state.clock)();
    let interval_s = eval_interval(&state);
    let snap = match state.obligations.as_deref() {
        Some(store) => store.snapshot(),
        None => Err(SpoolError::Unreadable),
    };
    match snap {
        Ok((items, records)) => {
            let obligations: Vec<Obligation> = items.iter().map(|i| i.obligation.clone()).collect();
            let readiness = launch_readiness(Ok(&obligations));
            let filtered: Vec<ObligationItemView> = items
                .into_iter()
                .filter(|item| {
                    query.kind.is_none_or(|k| item.obligation.kind() == k)
                        && query.state.is_none_or(|s| item.obligation.state() == s)
                })
                .map(|item| ObligationItemView::from_item(item, now))
                .collect();
            let count = Observed::current(
                filtered.len(),
                Some("count".to_owned()),
                "obligations".to_owned(),
                now,
                now,
                interval_s,
            );
            let last_at = records.last().map(|r| r.entry.at).unwrap_or(now);
            let source = SourceView {
                name: "obligations".to_owned(),
                kind: SourceKind::Obligations,
                producer: "ops-records".to_owned(),
                interval: interval_s.get(),
                observed_at: Some(last_at),
                age: u64::try_from((now - last_at).whole_seconds()).unwrap_or_default(),
                state: EvidenceState::Verified,
                reason: None,
            };
            Ok(no_store_json(ObligationsListResponse {
                evaluated_at: now,
                verdict: readiness.clone(),
                launch_readiness: readiness,
                items: filtered,
                count,
                sources: vec![source],
            }))
        }
        Err(err) => {
            let reason = err.reason();
            let readiness = launch_readiness(Err(&reason));
            Ok(no_store_json(ObligationsListResponse {
                evaluated_at: now,
                verdict: readiness.clone(),
                launch_readiness: readiness,
                items: Vec::new(),
                count: Observed::unknown("obligations".to_owned(), reason.clone()),
                sources: vec![unknown_source(reason, interval_s.get())],
            }))
        }
    }
}

pub async fn obligation_detail(
    State(state): State<OpsRestState>,
    headers: HeaderMap,
    path_id: Result<Path<String>, PathRejection>,
) -> Result<Response, OpsApiError> {
    const ROUTE: &str = "/api/ops/v1/obligations/{id}";
    state.authorize(&headers, "obligation.read", ROUTE)?;
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
    let now = (state.clock)();
    let interval_s = eval_interval(&state);
    let result = match state.obligations.as_deref() {
        Some(store) => store.detail(&id),
        None => Err(SpoolError::Unreadable),
    };
    match result {
        Ok(detail) => {
            let view = ObligationItemView::from_item(detail.item, now);
            let last_at = detail.history.last().map(|r| r.entry.at).unwrap_or(now);
            let source = SourceView {
                name: "obligations".to_owned(),
                kind: SourceKind::Obligations,
                producer: "ops-records".to_owned(),
                interval: interval_s.get(),
                observed_at: Some(last_at),
                age: u64::try_from((now - last_at).whole_seconds()).unwrap_or_default(),
                state: EvidenceState::Verified,
                reason: None,
            };
            let verdict = Verdict {
                text: format!("{}: {}", view.id, view.deadline),
                worst: if view.obligation.is_open()
                    && view.obligation.days_remaining(now).is_some_and(|d| d < 0)
                {
                    Health::Degraded
                } else {
                    Health::Healthy
                },
            };
            Ok(no_store_json(ObligationDetailResponse {
                evaluated_at: now,
                verdict,
                item: Some(view),
                history: detail.history,
                sources: vec![source],
            }))
        }
        Err(err @ SpoolError::Obligation(_)) => Err(from_obligation_error(err, sref, ROUTE)),
        Err(err) => {
            let reason = err.reason();
            Ok(no_store_json(ObligationDetailResponse {
                evaluated_at: now,
                verdict: Verdict {
                    text: format!("Unknown: {reason}"),
                    worst: Health::Unknown,
                },
                item: None,
                history: Vec::new(),
                sources: vec![unknown_source(reason, interval_s.get())],
            }))
        }
    }
}

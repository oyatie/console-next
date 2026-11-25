// SPDX-License-Identifier: LicenseRef-Proprietary
//! Filtered query handler for `GET /api/v1/payroll/runs`.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_payroll_adapter_postgres::{PayrollRunPage, list_runs_filtered_in_tx};
use console_platform_authz::Feature;
use console_platform_db::with_audits;
use serde::Deserialize;
use uuid::Uuid;

use crate::{PageParams, PayrollRestState, RestError, access, principal_from_headers};

#[derive(Debug, Default, Deserialize)]
pub(crate) struct RunListParams {
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<i64>,
    #[serde(default)]
    pub(crate) pay_group_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) legal_entity_id: Option<Uuid>,
}

impl From<PageParams> for RunListParams {
    fn from(value: PageParams) -> Self {
        Self {
            limit: value.limit,
            offset: value.offset,
            pay_group_id: None,
            legal_entity_id: None,
        }
    }
}

pub(crate) async fn list_runs_page(
    state: &PayrollRestState,
    headers: &HeaderMap,
    params: impl Into<RunListParams>,
) -> Result<PayrollRunPage, RestError> {
    let params = params.into();
    let principal = principal_from_headers(state, headers).await?;
    let (org, actor) = (principal.org_id, principal.user_id);
    let pool = state.store.pool().clone();
    with_audits::<_, PayrollRunPage, RestError>(&pool, org, move |tx| {
        Box::pin(async move {
            let read = Feature::PayrollRunRead;
            let facts = access::require_pay_action_in_tx(tx, org, actor, read).await?;
            let visible = access::visible_pay_groups(tx, &facts, read).await?;
            let page = list_runs_filtered_in_tx(
                tx,
                params.limit,
                params.offset,
                params.pay_group_id,
                params.legal_entity_id,
                &visible,
            )
            .await
            .map_err(RestError::from_store)?;
            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("payroll_run.list_read").map_err(RestError::from_kernel)?,
                "payroll_draft_run",
                "query",
                TraceContext::generate(),
                time::OffsetDateTime::now_utc(),
            )
            .with_org(org);
            Ok((page, vec![event]))
        })
    })
    .await
}

pub(crate) async fn list_runs(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    Query(params): Query<RunListParams>,
) -> Result<Response, RestError> {
    let page = list_runs_page(&state, &headers, params).await?;
    Ok(Json(page).into_response())
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
use console_payroll_adapter_postgres::{PayrollRunDetail, get_run_filtered_in_tx};
use console_platform_authz::Feature;
use console_platform_db::with_audits;
use uuid::Uuid;

use crate::{PayrollRestState, RestError, access, principal_from_headers};

#[derive(Debug, serde::Deserialize)]
pub(crate) struct RunDetailParams {
    limit: Option<i64>,
    offset: Option<i64>,
    missing_bank_only: Option<bool>,
    q: Option<String>,
}

pub(crate) async fn get_run(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    Path(run_id): Path<Uuid>,
    Query(params): Query<RunDetailParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;

    let (org, actor) = (principal.org_id, principal.user_id);
    let pool = state.store.pool().clone();
    let missing_bank_only = params.missing_bank_only.unwrap_or(false);
    let q = params.q;
    let detail = with_audits::<_, Option<PayrollRunDetail>, RestError>(&pool, org, move |tx| {
        Box::pin(async move {
            access::require_run_in_tx(tx, org, actor, Feature::PayrollRunRead, run_id).await?;
            let detail = get_run_filtered_in_tx(
                tx,
                run_id,
                params.limit,
                params.offset,
                missing_bank_only,
                q.as_deref(),
            )
            .await
            .map_err(RestError::from_store)?;
            let events = if detail.is_some() {
                vec![
                    AuditEvent::new(
                        Some(actor),
                        AuditAction::new("payroll_run.read").map_err(RestError::from_kernel)?,
                        "payroll_draft_run",
                        run_id.to_string(),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .with_org(org),
                ]
            } else {
                Vec::new()
            };
            Ok((detail, events))
        })
    })
    .await?;

    let detail = detail
        .ok_or_else(|| RestError::new(StatusCode::NOT_FOUND, "not_found", "run not found"))?;
    Ok(Json(detail).into_response())
}

// SPDX-License-Identifier: LicenseRef-Proprietary
//! Own readiness admission and data share the canonical facts transaction.
use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use console_payroll_adapter_postgres::{MyPayrollLinePage, list_my_lines_in_tx};
use console_platform_authz::cedar_pbac::visible::load_facts;

use crate::{PageParams, PayrollRestState, RestError, principal_from_headers};

pub(super) async fn list_my_lines(
    State(state): State<PayrollRestState>,
    headers: HeaderMap,
    Query(params): Query<PageParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let page = console_platform_db::with_org_conn::<_, _, RestError>(
        state.store.pool(),
        principal.org_id,
        move |tx| {
            Box::pin(async move {
                let facts = load_facts(tx, principal.org_id, *principal.user_id.as_uuid())
                    .await
                    .map_err(RestError::from_kernel)?;
                let Some(employee) = facts.linked_employee_id() else {
                    return Ok(MyPayrollLinePage {
                        items: Vec::new(),
                        total: 0,
                        limit: params.limit.unwrap_or(100),
                        offset: params.offset.unwrap_or(0),
                    });
                };
                let allowed = facts
                    .authorize_employee_self_read(employee)
                    .map_err(|error| {
                        tracing::error!(%error, "employee self-read Cedar decision failed");
                        RestError::unavailable("employee self-read decision is unavailable")
                    })?;
                if !allowed {
                    return Err(RestError::from_kernel(
                        console_kernel_core::KernelError::forbidden(
                            "employee self-read requires the caller's own record",
                        ),
                    ));
                }
                list_my_lines_in_tx(tx, employee, params.limit, params.offset)
                    .await
                    .map_err(RestError::from_store)
            })
        },
    )
    .await?;
    Ok(Json(page).into_response())
}

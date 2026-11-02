// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    access_log, context::principal_from_headers, error::RestError, state::IdentityRestState,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use console_identity_application::{AccountStatus, EmployeeLinkStatus};
use console_kernel_core::{BranchId, UserId};
use serde::Serialize;
use uuid::Uuid;

/// Access labels, employee reference and sign-in state; contact details never cross this boundary.
#[derive(Serialize)]
pub(crate) struct AccessPerson {
    id: UserId,
    display_name: String,
    sign_in_id: Option<String>,
    employee_id: Option<Uuid>,
    employee_name: Option<String>,
    employee_number: Option<String>,
    employee_company: Option<String>,
    employee_org_unit: Option<String>,
    employee_link_status: EmployeeLinkStatus,
    roles: Vec<String>,
    branch_ids: Vec<BranchId>,
    is_active: bool,
    is_tenant_ops: bool,
    has_passkey: bool,
    account_status: AccountStatus,
}

pub(crate) async fn get_access_person(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<AccessPerson>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .get_access_person(principal.user_id, UserId::from_uuid(id))
        .await
        .map_err(RestError::from_store)?;
    access_log::record_account_read(state.pool(), &principal, &summary).await?;
    Ok(Json(AccessPerson {
        id: summary.id,
        display_name: summary.display_name,
        sign_in_id: summary.sign_in_id,
        employee_id: summary.employee_id,
        employee_name: summary.employee_name,
        employee_number: summary.employee_number,
        employee_company: summary.employee_company,
        employee_org_unit: summary.employee_org_unit,
        employee_link_status: summary.employee_link_status,
        roles: summary.roles,
        branch_ids: summary.branch_ids,
        is_active: summary.is_active,
        is_tenant_ops: summary.is_tenant_ops,
        has_passkey: summary.has_passkey,
        account_status: summary.account_status,
    }))
}

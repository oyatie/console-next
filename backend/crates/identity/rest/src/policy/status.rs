use crate::cedar_shadow::authorize_org_manage_observed;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::metrics::policy_branch_scope_label;
use crate::metrics::record_policy_studio_operation;
use crate::policy::convert::build_policy_role_status_preview;
use crate::policy::delegation::ensure_policy_roles_inside_delegated_authority_for_operation;
use crate::policy::dto::PolicyRoleResponse;
use crate::policy::dto::PolicyRoleStatusPreviewRequest;
use crate::policy::dto::UpdatePolicyRoleStatusRequest;
use crate::policy::runtime::normalize_policy_role_status;
use crate::policy::runtime::validate_policy_role_status_transition;
use crate::policy::step_up::verify_policy_step_up;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_identity_application::UpdatePolicyRoleStatusCommand;
use console_kernel_core::KernelError;
use console_kernel_core::TraceContext;
use console_platform_authz::Feature;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn preview_policy_role_status(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PolicyRoleStatusPreviewRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let requested_status = normalize_policy_role_status(&body.status)?;
    let role = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|role| role.id == id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("policy role not found")))?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "preview_role_status",
        &principal,
        std::slice::from_ref(&role),
    )?;
    validate_policy_role_status_transition(&role.status, &requested_status)?;
    let planned_assignment_count = state
        .store
        .count_policy_role_assignments(id)
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("preview_role_status", "success");
    tracing::info!(
        event = "policy_studio_role_status_previewed",
        operation = "preview_role_status",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        current_status = %role.status,
        requested_status = %requested_status,
        planned_assignment_count,
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role status previewed"
    );
    Ok(Json(build_policy_role_status_preview(
        &role,
        requested_status,
        planned_assignment_count,
    )))
}

pub(crate) async fn update_policy_role_status(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdatePolicyRoleStatusRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let status = normalize_policy_role_status(&body.status)?;
    let role = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|role| role.id == id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("policy role not found")))?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "update_role_status",
        &principal,
        std::slice::from_ref(&role),
    )?;
    validate_policy_role_status_transition(&role.status, &status)?;
    verify_policy_step_up(&state, &principal, body.step_up).await?;

    let trace = TraceContext::generate();
    let role = state
        .store
        .update_policy_role_status(UpdatePolicyRoleStatusCommand {
            actor: principal.user_id,
            role_id: id,
            status,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("update_role_status", "success");
    tracing::info!(
        event = "policy_studio_role_status_updated",
        operation = "update_role_status",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        status = %role.status,
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role status updated"
    );
    Ok(Json(PolicyRoleResponse::from(role)))
}

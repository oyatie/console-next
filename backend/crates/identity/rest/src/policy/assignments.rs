use crate::cedar_shadow::authorize_org_manage_observed;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::metrics::policy_branch_scope_label;
use crate::metrics::record_policy_studio_operation;
use crate::policy::delegation::ensure_assignment_preview_acknowledged;
use crate::policy::delegation::ensure_policy_roles_inside_actor_permission_ceiling_for_operation;
use crate::policy::delegation::ensure_policy_roles_inside_delegated_authority_for_operation;
use crate::policy::delegation::require_assignment_preview_receipt;
use crate::policy::dto::ListPolicyAssignmentsRequest;
use crate::policy::dto::PolicyRoleAssignmentResponse;
use crate::policy::dto::ReplacePolicyRoleAssignmentsRequest;
use crate::policy::requested::policy_roles_touched_by_assignment_replace;
use crate::policy::requested::reject_new_ai_role_assignments;
use crate::policy::requested::validate_requested_policy_roles;
use crate::policy::step_up::verify_policy_step_up;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_identity_application::ReplacePolicyRoleAssignmentsCommand;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_authz::Feature;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn list_policy_assignments(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(query): Query<ListPolicyAssignmentsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let Some(user_id) = query.user_id.map(UserId::from_uuid) else {
        return Err(RestError::validation("user_id query parameter is required"));
    };
    // Custom-role assignments are user governance data and ACTIVE roles are
    // runtime-effective, so branch-scoped RoleManage holders may only inspect
    // targets visible in their live branch scope.
    state
        .store
        .get_user(user_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let assignments = state
        .store
        .list_policy_role_assignments(user_id)
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(PolicyRoleAssignmentResponse::from)
        .collect::<Vec<_>>();
    record_policy_studio_operation("list_assignments", "success");
    tracing::info!(
        event = "policy_studio_assignments_listed",
        operation = "list_assignments",
        outcome = "success",
        actor_user_id = %principal.user_id,
        target_user_id = %user_id,
        assignment_count = assignments.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio assignments listed"
    );
    Ok(Json(assignments))
}

pub(crate) async fn replace_policy_assignments(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ReplacePolicyRoleAssignmentsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let user_id = UserId::from_uuid(id);
    state
        .store
        .get_user(user_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let current_assignments = state
        .store
        .list_policy_role_assignments(user_id)
        .await
        .map_err(RestError::from_store)?;
    let custom_roles = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?;
    let requested_role_ids = body.role_ids.clone().unwrap_or_default();
    let requested_roles = validate_requested_policy_roles(&custom_roles, &requested_role_ids)?;
    reject_new_ai_role_assignments(&requested_roles, &current_assignments)?;
    let authorized_roles = policy_roles_touched_by_assignment_replace(
        &custom_roles,
        &requested_roles,
        &current_assignments,
    )?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "replace_assignments",
        &principal,
        &authorized_roles,
    )?;
    ensure_policy_roles_inside_actor_permission_ceiling_for_operation(
        "replace_assignments",
        &principal,
        &authorized_roles,
    )?;
    ensure_assignment_preview_acknowledged(&principal, body.preview_acknowledged)?;
    let preview_receipt_id =
        require_assignment_preview_receipt(&principal, body.preview_receipt_id)?;
    verify_policy_step_up(&state, &principal, body.step_up).await?;
    let trace = TraceContext::generate();
    let assignments = state
        .store
        .replace_policy_role_assignments(ReplacePolicyRoleAssignmentsCommand {
            actor: principal.user_id,
            user_id,
            role_ids: requested_role_ids,
            preview_receipt_id,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(PolicyRoleAssignmentResponse::from)
        .collect::<Vec<_>>();
    record_policy_studio_operation("replace_assignments", "success");
    tracing::info!(
        event = "policy_studio_assignments_replaced",
        operation = "replace_assignments",
        outcome = "success",
        actor_user_id = %principal.user_id,
        target_user_id = %user_id,
        assignment_count = assignments.len(),
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio assignments replaced"
    );
    Ok(Json(assignments))
}

use crate::cedar_shadow::authorize_org_manage_observed;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::metrics::policy_branch_scope_label;
use crate::metrics::record_policy_studio_operation;
use crate::policy::delegation::ensure_policy_conditions_inside_delegated_authority_for_operation;
use crate::policy::delegation::ensure_policy_roles_inside_delegated_authority_for_operation;
use crate::policy::dto::CreatePolicyRoleRequest;
use crate::policy::dto::PolicyRoleResponse;
use crate::policy::dto::UpdatePolicyRoleRequest;
use crate::policy::step_up::verify_policy_step_up;
use crate::policy::validate::normalize_policy_description;
use crate::policy::validate::normalize_policy_display_name;
use crate::policy::validate::normalize_policy_role_key;
use crate::policy::validate::validate_policy_conditions;
use crate::policy::validate::validate_policy_permissions;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_identity_application::CreatePolicyRoleCommand;
use console_identity_application::PolicyRoleSummary;
use console_identity_application::UpdatePolicyRoleCommand;
use console_kernel_core::KernelError;
use console_kernel_core::TraceContext;
use console_platform_authz::Feature;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn create_policy_role(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<CreatePolicyRoleRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let role_key = normalize_policy_role_key(&body.role_key)?;
    let display_name = normalize_policy_display_name(&body.display_name)?;
    let description = normalize_policy_description(body.description.as_deref())?;
    let permissions = validate_policy_permissions(&body.permissions, false)?;
    let conditions = validate_policy_conditions(&body.conditions)?;
    ensure_policy_conditions_inside_delegated_authority_for_operation(
        "create_role",
        &principal,
        &conditions,
    )?;

    let trace = TraceContext::generate();
    let role = state
        .store
        .create_policy_role(CreatePolicyRoleCommand {
            actor: principal.user_id,
            role_key,
            display_name,
            description,
            permissions,
            conditions,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("create_role", "success");
    tracing::info!(
        event = "policy_studio_role_created",
        operation = "create_role",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        permission_count = role.permissions.len(),
        condition_count = role.conditions.len(),
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role created"
    );
    Ok((StatusCode::CREATED, Json(PolicyRoleResponse::from(role))))
}

pub(crate) async fn update_policy_role(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdatePolicyRoleRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let display_name = normalize_policy_display_name(&body.display_name)?;
    let description = normalize_policy_description(body.description.as_deref())?;
    let conditions = validate_policy_conditions(&body.conditions)?;
    let role = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|role| role.id == id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("policy role not found")))?;
    if role.is_system {
        return Err(RestError::validation(
            "system policy roles cannot be changed",
        ));
    }
    let legacy_ai_only = role
        .permissions
        .iter()
        .any(|permission| permission.feature_key == Feature::AiAssist.as_str())
        && role
            .permissions
            .iter()
            .all(|permission| permission.feature_key == Feature::AiAssist.as_str());
    let permissions = validate_policy_permissions(&body.permissions, legacy_ai_only)?;
    let requested_role = PolicyRoleSummary {
        id: role.id,
        role_key: role.role_key.clone(),
        display_name: display_name.clone(),
        description: description.clone(),
        status: role.status.clone(),
        is_system: role.is_system,
        permissions: permissions.clone(),
        conditions: conditions.clone(),
        created_at: role.created_at,
        updated_at: role.updated_at,
    };
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "update_role",
        &principal,
        &[role.clone(), requested_role],
    )?;
    verify_policy_step_up(&state, &principal, body.step_up).await?;

    let trace = TraceContext::generate();
    let role = state
        .store
        .update_policy_role(UpdatePolicyRoleCommand {
            actor: principal.user_id,
            role_id: id,
            display_name,
            description,
            permissions,
            conditions,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("update_role", "success");
    tracing::info!(
        event = "policy_studio_role_updated",
        operation = "update_role",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        permission_count = role.permissions.len(),
        condition_count = role.conditions.len(),
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role updated"
    );
    Ok(Json(PolicyRoleResponse::from(role)))
}

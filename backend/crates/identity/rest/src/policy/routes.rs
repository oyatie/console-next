use crate::cedar_shadow::authorize_org_manage_observed;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::metrics::policy_branch_scope_label;
use crate::metrics::record_policy_studio_operation;
use crate::policy::delegation::policy_role_is_inside_delegated_authority;
use crate::policy::dto::PolicyAuditEventResponse;
use crate::policy::dto::PolicyAuditEventsQuery;
use crate::policy::dto::PolicyRoleCatalogResponse;
use crate::policy::dto::PolicyRoleResponse;
use crate::policy::runtime::normalize_policy_audit_limit;
use crate::policy::templates::policy_feature_catalog;
use crate::policy::templates::policy_role_templates;
use crate::policy::templates::system_policy_roles;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::Query;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_platform_authz::Feature;

// ---------------------------------------------------------------------------
// Policy Studio handlers (G016-P0)
// ---------------------------------------------------------------------------

pub(crate) async fn list_policy_features(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let catalog = policy_feature_catalog();
    record_policy_studio_operation("list_features", "success");
    tracing::info!(
        event = "policy_studio_features_listed",
        operation = "list_features",
        outcome = "success",
        actor_user_id = %principal.user_id,
        feature_count = catalog.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio features listed"
    );
    Ok(Json(catalog))
}

pub(crate) async fn list_policy_roles(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let custom_roles = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .filter(|role| policy_role_is_inside_delegated_authority(&principal, role))
        .map(PolicyRoleResponse::from)
        .collect::<Vec<_>>();
    let policy_version = state
        .store
        .get_policy_version()
        .await
        .map_err(RestError::from_store)?;
    let system_roles = system_policy_roles();
    record_policy_studio_operation("list_roles", "success");
    tracing::info!(
        event = "policy_studio_roles_listed",
        operation = "list_roles",
        outcome = "success",
        actor_user_id = %principal.user_id,
        custom_role_count = custom_roles.len(),
        system_role_count = system_roles.len(),
        policy_version = policy_version.version,
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio roles listed"
    );
    Ok(Json(PolicyRoleCatalogResponse {
        policy_version: policy_version.into(),
        system_roles,
        custom_roles,
    }))
}

pub(crate) async fn list_policy_role_templates(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let templates = policy_role_templates();
    record_policy_studio_operation("list_templates", "success");
    tracing::info!(
        event = "policy_studio_templates_listed",
        operation = "list_templates",
        outcome = "success",
        actor_user_id = %principal.user_id,
        template_count = templates.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role templates listed"
    );
    Ok(Json(templates))
}

pub(crate) async fn list_policy_audit_events(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(query): Query<PolicyAuditEventsQuery>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    let limit = normalize_policy_audit_limit(query.limit)?;
    let events = state
        .store
        .list_policy_audit_events(limit)
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(PolicyAuditEventResponse::from)
        .collect::<Vec<_>>();
    record_policy_studio_operation("list_audit_events", "success");
    tracing::info!(
        event = "policy_studio_audit_events_listed",
        operation = "list_audit_events",
        outcome = "success",
        actor_user_id = %principal.user_id,
        event_count = events.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio audit events listed"
    );
    Ok(Json(events))
}

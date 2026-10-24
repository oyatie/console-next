use crate::authz::authorize_org_manage;
use crate::cedar_shadow::authorize_org_manage_observed;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::metrics::policy_branch_scope_label;
use crate::metrics::record_policy_studio_operation;
use crate::policy::convert::policy_condition_response;
use crate::policy::delegation::ensure_policy_roles_inside_actor_permission_ceiling_for_operation;
use crate::policy::delegation::ensure_policy_roles_inside_delegated_authority_for_operation;
use crate::policy::dto::PolicyAssignmentPreviewResponse;
use crate::policy::dto::PolicyFeatureGrantPreviewResponse;
use crate::policy::dto::PolicyRoleAssignmentDeltaResponse;
use crate::policy::dto::PolicyRoleImpactResponse;
use crate::policy::dto::ReplacePolicyRoleAssignmentsRequest;
use crate::policy::requested::policy_roles_touched_by_assignment_replace;
use crate::policy::requested::reject_new_ai_role_assignments;
use crate::policy::requested::validate_requested_policy_roles;
use crate::policy::runtime::policy_role_runtime_decision_for_user;
use crate::policy::runtime::runtime_allowed_policy_permissions;
use crate::state::IdentityRestState;
use crate::users::authz::authorize_user_write;
use crate::users::authz::elevated_role_membership_changes;
use crate::users::authz::parse_roles;
use crate::users::authz::role_db_strings;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_identity_application::CreatePolicyAssignmentPreviewReceiptCommand;
use console_kernel_core::UserId;
use console_platform_authz::Feature;
use console_platform_authz::PermissionLevel;
use console_platform_authz::Role;
use console_platform_authz::permission_for;
use std::collections::BTreeSet;
use std::str::FromStr;
use time::Duration;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) const POLICY_ASSIGNMENT_PREVIEW_RECEIPT_TTL: Duration = Duration::minutes(10);
pub(crate) async fn preview_policy_assignments(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ReplacePolicyRoleAssignmentsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let user_id = UserId::from_uuid(id);
    // Fine-grained, deny-by-omission authorization: an account-scope change
    // (system roles / branch memberships) is the UserManage tier (ADMIN), while
    // a custom policy-role change is the stricter RoleManage tier (SUPER_ADMIN).
    // No unconditional top-level RoleManage gate — that would 403 a legitimate
    // ADMIN doing an account-scope-only preview.
    let account_scope_preview = body.system_roles.is_some() || body.branch_ids.is_some();
    let explicit_custom_role_preview = body.role_ids.is_some();
    if account_scope_preview {
        authorize_org_manage(&principal, Feature::UserManage)?;
    }
    if !account_scope_preview || explicit_custom_role_preview {
        authorize_org_manage_observed(&state, &principal, Feature::RoleManage).await?;
    }
    let user = state
        .store
        .get_user(user_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let current_assignments = state
        .store
        .list_policy_role_assignments(user_id)
        .await
        .map_err(RestError::from_store)?;
    let policy_version = state
        .store
        .get_policy_version()
        .await
        .map_err(RestError::from_store)?;
    let custom_roles = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?;
    let current_ids = current_assignments
        .iter()
        .map(|assignment| assignment.role_id)
        .collect::<BTreeSet<_>>();
    let requested_role_id_input = match (&body.role_ids, account_scope_preview) {
        (Some(role_ids), _) => role_ids.clone(),
        (None, true) => current_ids.iter().copied().collect(),
        (None, false) => Vec::new(),
    };
    let requested_roles = validate_requested_policy_roles(&custom_roles, &requested_role_id_input)?;
    reject_new_ai_role_assignments(&requested_roles, &current_assignments)?;
    let current_system_roles = role_db_strings(&parse_roles(&user.roles)?);
    let requested_system_role_set = match &body.system_roles {
        Some(raw) => Some(parse_roles(raw)?),
        None => None,
    };
    let requested_system_roles = requested_system_role_set
        .as_ref()
        .map(role_db_strings)
        .unwrap_or_else(|| current_system_roles.clone());
    let current_branch_ids = user
        .branch_ids
        .iter()
        .map(|branch_id| *branch_id.as_uuid())
        .collect::<Vec<_>>();
    let requested_branch_ids = body
        .branch_ids
        .as_ref()
        .map(|branch_ids| {
            branch_ids
                .iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect()
        })
        .unwrap_or_else(|| current_branch_ids.clone());
    if account_scope_preview {
        let elevated_role_changes =
            elevated_role_membership_changes(&user.roles, requested_system_role_set.as_ref())?;
        let target_branches = body
            .branch_ids
            .as_deref()
            .unwrap_or(user.branch_ids.as_slice());
        authorize_user_write(
            &principal,
            &elevated_role_changes,
            user.branch_ids.as_slice(),
            target_branches,
        )?;
    }
    let requested_ids = requested_roles
        .iter()
        .map(|role| role.id)
        .collect::<BTreeSet<_>>();
    let authorized_roles = policy_roles_touched_by_assignment_replace(
        &custom_roles,
        &requested_roles,
        &current_assignments,
    )?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "presupportsignments",
        &principal,
        &authorized_roles,
    )?;
    ensure_policy_roles_inside_actor_permission_ceiling_for_operation(
        "presupportsignments",
        &principal,
        &authorized_roles,
    )?;

    let requested_role_ids = requested_ids.iter().copied().collect::<Vec<_>>();
    let delta = PolicyRoleAssignmentDeltaResponse {
        added_role_ids: requested_ids.difference(&current_ids).copied().collect(),
        removed_role_ids: current_ids.difference(&requested_ids).copied().collect(),
        unchanged_role_ids: requested_ids.intersection(&current_ids).copied().collect(),
    };

    let mut feature_grants = Vec::new();
    for role_code in &requested_system_roles {
        let role = Role::from_str(role_code)
            .map_err(|_| RestError::validation("user has an unknown system role"))?;
        for feature in Feature::ALL {
            let permission = permission_for(role, feature);
            if matches!(permission, PermissionLevel::Deny) {
                continue;
            }
            feature_grants.push(PolicyFeatureGrantPreviewResponse {
                feature_key: feature.as_str().to_owned(),
                permission_level: permission.as_str().to_owned(),
                source_type: "system_role".to_owned(),
                source_key: role.as_str().to_owned(),
                source_label: role.as_str().to_owned(),
            });
        }
    }
    let mut runtime_warning_codes = BTreeSet::new();
    let mut custom_role_impacts = Vec::with_capacity(requested_roles.len());
    for role in &requested_roles {
        let runtime_decision = policy_role_runtime_decision_for_user(role, &user);
        for warning in &runtime_decision.warnings {
            runtime_warning_codes.insert(warning.clone());
        }
        if runtime_decision.effective {
            for permission in runtime_allowed_policy_permissions(role) {
                feature_grants.push(PolicyFeatureGrantPreviewResponse {
                    feature_key: permission.feature_key.clone(),
                    permission_level: permission.permission_level.clone(),
                    source_type: "custom_role".to_owned(),
                    source_key: role.role_key.clone(),
                    source_label: role.display_name.clone(),
                });
            }
        }
        custom_role_impacts.push(PolicyRoleImpactResponse {
            role_id: role.id,
            role_key: role.role_key.clone(),
            display_name: role.display_name.clone(),
            status: role.status.clone(),
            runtime_effective: runtime_decision.effective,
            runtime_warnings: runtime_decision.warnings,
            conditions: role
                .conditions
                .iter()
                .cloned()
                .map(policy_condition_response)
                .collect(),
        });
    }
    feature_grants.sort_by(|left, right| {
        (
            &left.feature_key,
            &left.source_type,
            &left.source_key,
            &left.permission_level,
        )
            .cmp(&(
                &right.feature_key,
                &right.source_type,
                &right.source_key,
                &right.permission_level,
            ))
    });

    let assignment_runtime_effective = custom_role_impacts
        .iter()
        .any(|role| role.runtime_effective);
    let mut warnings = vec!["preview_only_pending_save".to_owned()];
    if assignment_runtime_effective {
        warnings.push("active_assignments_become_runtime_effective_after_save".to_owned());
    }
    warnings.extend(runtime_warning_codes);

    let requested_role_count = requested_roles.len();
    let custom_roles = custom_role_impacts;
    let current_role_ids = current_ids.iter().copied().collect::<Vec<_>>();
    let preview_receipt = state
        .store
        .create_policy_assignment_preview_receipt(CreatePolicyAssignmentPreviewReceiptCommand {
            actor: principal.user_id,
            user_id,
            current_branch_ids: current_branch_ids.clone(),
            current_system_roles: current_system_roles.clone(),
            current_role_ids: current_role_ids.clone(),
            branch_ids: requested_branch_ids.clone(),
            system_roles: requested_system_roles.clone(),
            role_ids: requested_role_ids.clone(),
            policy_version: policy_version.version,
            expires_at: OffsetDateTime::now_utc() + POLICY_ASSIGNMENT_PREVIEW_RECEIPT_TTL,
        })
        .await
        .map_err(RestError::from_store)?;

    record_policy_studio_operation("presupportsignments", "success");
    tracing::info!(
        event = "policy_studio_assignment_previewed",
        operation = "presupportsignments",
        outcome = "success",
        actor_user_id = %principal.user_id,
        target_user_id = %user_id,
        requested_role_count,
        feature_grant_count = feature_grants.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio assignment previewed"
    );

    Ok(Json(PolicyAssignmentPreviewResponse {
        user_id: *user_id.as_uuid(),
        preview_receipt_id: preview_receipt.id,
        preview_receipt_expires_at: preview_receipt.expires_at,
        effective: assignment_runtime_effective,
        system_roles: requested_system_roles.clone(),
        current_system_roles,
        requested_system_roles,
        current_branch_ids,
        requested_branch_ids,
        current_role_ids,
        requested_role_ids,
        delta,
        custom_roles,
        feature_grants,
        warnings,
    }))
}

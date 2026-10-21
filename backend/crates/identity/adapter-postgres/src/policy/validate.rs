use crate::PgOrgError;
use console_identity_application::PolicyRolePermission;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, PermissionLevel, custom_role_runtime_feature_allowed};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;
use std::str::FromStr;

pub(crate) async fn validate_custom_policy_roles_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_ids: &[uuid::Uuid],
) -> Result<(), PgOrgError> {
    if role_ids.is_empty() {
        return Ok(());
    }
    let rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM policy_roles
        WHERE id = ANY($1) AND is_system = false AND status <> 'RETIRED'
        "#,
    )
    .bind(role_ids.to_vec())
    .fetch_all(tx.as_mut())
    .await?;
    if rows.len() != role_ids.len() {
        return Err(PgOrgError::Domain(KernelError::validation(
            "assignment references an unknown or retired custom role",
        )));
    }
    Ok(())
}

pub(crate) fn validate_owner_policy_permissions(
    permissions: &[PolicyRolePermission],
    allow_empty: bool,
) -> Result<(), PgOrgError> {
    if permissions.is_empty() && !allow_empty {
        return Err(PgOrgError::Domain(KernelError::validation(
            "custom role must grant at least one non-deny feature",
        )));
    }
    let mut seen = BTreeSet::new();
    for permission in permissions {
        let feature = Feature::from_str(&permission.feature_key)
            .map_err(|_| KernelError::validation("unknown feature key"))?;
        let level = PermissionLevel::from_str(&permission.permission_level)
            .map_err(|_| KernelError::validation("unknown permission level"))?;
        if !custom_role_runtime_feature_allowed(feature) {
            return Err(PgOrgError::Domain(KernelError::forbidden(
                "custom role cannot grant this feature",
            )));
        }
        if level == PermissionLevel::Deny || !seen.insert(feature.as_str()) {
            return Err(PgOrgError::Domain(KernelError::validation(
                "custom role permissions must be distinct, non-deny grants",
            )));
        }
    }
    Ok(())
}

pub(crate) async fn reject_new_ai_role_assignments_tx(
    tx: &mut Transaction<'_, Postgres>,
    requested_role_ids: &[uuid::Uuid],
    current_role_ids: &[uuid::Uuid],
) -> Result<(), PgOrgError> {
    let added_role_ids = requested_role_ids
        .iter()
        .filter(|role_id| !current_role_ids.contains(role_id))
        .copied()
        .collect::<Vec<_>>();
    if added_role_ids.is_empty() {
        return Ok(());
    }
    let adds_ai_role: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM policy_role_permissions WHERE role_id = ANY($1) AND feature_key = $2)",
    )
    .bind(&added_role_ids)
    .bind(Feature::AiAssist.as_str())
    .fetch_one(tx.as_mut())
    .await?;
    if adds_ai_role {
        return Err(PgOrgError::Domain(KernelError::forbidden(
            "retired AI roles cannot be newly assigned",
        )));
    }
    Ok(())
}

pub(crate) fn normalize_policy_role_ids(role_ids: Vec<uuid::Uuid>) -> Vec<uuid::Uuid> {
    role_ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn normalize_system_roles(roles: Vec<String>) -> Vec<String> {
    roles
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

use crate::context::load::UserAuthContext;
use crate::error::RestError;
use console_kernel_core::OrgId;
use console_platform_authz::EffectiveFeatureGrant;
use console_platform_authz::Role;
use console_platform_authz::resolve_branch_scope_in_org;
use console_platform_authz::resolve_branch_scope_in_tx;
use console_platform_authz::resolve_effective_feature_grants_in_org;
use console_platform_authz::resolve_effective_feature_grants_in_tx;
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::str::FromStr;

pub(crate) async fn resolve_feature_grant_keys_for_user(
    pool: &PgPool,
    context: &UserAuthContext,
) -> Result<Vec<String>, RestError> {
    if context.org_id == OrgId::platform() {
        return Ok(Vec::new());
    }

    let roles = context
        .roles
        .iter()
        .map(|role| Role::from_str(role).map_err(|err| RestError::internal(err.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    let branch_scope = resolve_branch_scope_in_org(pool, context.org_id, context.user_id, &roles)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    let grants = resolve_effective_feature_grants_in_org(
        pool,
        context.org_id,
        context.user_id,
        &branch_scope,
    )
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(feature_grant_keys(grants))
}

pub(crate) async fn resolve_feature_grant_keys_for_user_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    context: &UserAuthContext,
) -> Result<Vec<String>, RestError> {
    if context.org_id == OrgId::platform() {
        return Ok(Vec::new());
    }
    let roles = context
        .roles
        .iter()
        .map(|role| Role::from_str(role).map_err(|err| RestError::internal(err.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    let branch_scope = resolve_branch_scope_in_tx(tx, context.user_id, &roles)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    let grants =
        resolve_effective_feature_grants_in_tx(tx, context.org_id, context.user_id, &branch_scope)
            .await
            .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(feature_grant_keys(grants))
}

pub(crate) fn feature_grant_keys(grants: Vec<EffectiveFeatureGrant>) -> Vec<String> {
    grants
        .into_iter()
        .map(|grant| grant.feature.as_str().to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

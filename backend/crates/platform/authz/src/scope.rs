use console_kernel_core::{
    AccessScope, AccessScopeLevel, BranchId, BranchProjection, BranchScope, KernelError, OrgId,
    UserId,
};
use sqlx::{PgPool, Postgres, Transaction};

use crate::{Feature, PermissionLevel, Principal, Role, permission_for};

/// Resolve branch scope from `user_branches` under an explicitly-armed tenant.
///
/// `SUPER_ADMIN` and `EXECUTIVE` resolve to [`BranchScope::All`] for global
/// read/rollup surfaces; write authority is still constrained by the matrix.
///
/// `user_branches` is FORCE RLS, so a bare-pool read returns ZERO branches when
/// `app.current_org` is unset — silently narrowing a non-super admin's scope to
/// nothing. This opens a transaction, arms the GUC to `org` (the caller's
/// verified-token tenant), then runs the query, so RLS narrows to exactly that
/// org's memberships. Callers that run BEFORE the per-request tenant middleware
/// (the principal-resolution paths) pass the org from the verified token.
pub async fn resolve_branch_scope_in_org(
    pool: &PgPool,
    org: OrgId,
    user_id: UserId,
    roles: &[Role],
) -> Result<BranchScope, KernelError> {
    if roles
        .iter()
        .any(|role| matches!(role, Role::SuperAdmin | Role::Executive))
    {
        return Ok(BranchScope::All);
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;
    let scope = resolve_branch_scope_in_tx(&mut tx, user_id, roles).await?;
    tx.commit()
        .await
        .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;
    Ok(scope)
}

/// Resolve branch scope inside the caller's already Company-armed transaction.
pub async fn resolve_branch_scope_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    roles: &[Role],
) -> Result<BranchScope, KernelError> {
    if roles
        .iter()
        .any(|role| matches!(role, Role::SuperAdmin | Role::Executive))
    {
        return Ok(BranchScope::All);
    }
    let rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await
    .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;

    Ok(BranchScope::Branches(
        rows.into_iter().map(BranchId::from_uuid).collect(),
    ))
}

/// Apply a claim-level hierarchy scope to a live DB membership scope for one
/// ordinary tenant route.
///
/// The live scope is authoritative for membership revocation. The access scope
/// may only narrow that set; it never widens. A `Group` access scope is rejected
/// here because group-wide reads must use the consolidated group helper, which
/// first resolves authorized member orgs and then performs N separately armed
/// per-org reads. Region/worksite projections are not wired yet, so they fail
/// closed until a DB-backed hierarchy resolver supplies a matching projection.
pub fn effective_branch_scope_for_tenant(
    live_scope: BranchScope,
    access_scope: AccessScope,
    org_id: OrgId,
) -> Result<BranchScope, KernelError> {
    let projected_scope = match access_scope.level {
        AccessScopeLevel::Group => {
            return Err(KernelError::forbidden(
                "group access scope must use a group fan-out resolver",
            ));
        }
        AccessScopeLevel::Org => access_scope.branch_scope_for_org(org_id, None),
        AccessScopeLevel::Branch => {
            let branch_id = BranchId::from_uuid(*access_scope.node_id.as_uuid());
            let projection = BranchProjection::single(access_scope.node_id, org_id, branch_id);
            access_scope.branch_scope_for_org(org_id, Some(&projection))
        }
        AccessScopeLevel::Region | AccessScopeLevel::Worksite => {
            access_scope.branch_scope_for_org(org_id, None)
        }
    };

    Ok(live_scope.intersect(&projected_scope))
}

/// The exact branch scope of a people-directory read, or `None` when nothing
/// allows one. Built-in grants hold across the caller's live membership scope;
/// custom grants contribute only their resolved scope, re-intersected here with
/// live membership. Choosing a person anywhere (the directory, a request's
/// assignee) reads this one scope, so the two cannot disagree.
#[must_use]
pub fn directory_read_scope(principal: &Principal) -> Option<BranchScope> {
    let union = |a: &BranchScope, b: &BranchScope| match (a, b) {
        (BranchScope::All, _) | (_, BranchScope::All) => BranchScope::All,
        (BranchScope::Branches(x), BranchScope::Branches(y)) => {
            BranchScope::Branches(x.union(y).copied().collect())
        }
    };
    let mut effective = BranchScope::Branches(std::collections::BTreeSet::new());
    let role_allows = principal.roles.iter().any(|role| {
        permission_for(*role, Feature::EmployeeDirectoryRead) == PermissionLevel::Allow
    });
    if role_allows {
        effective = union(&effective, &principal.branch_scope);
    }
    for grant in principal.effective_feature_grants.iter().filter(|grant| {
        grant.feature == Feature::EmployeeDirectoryRead
            && grant.permission == PermissionLevel::Allow
    }) {
        effective = union(
            &effective,
            &principal.branch_scope.intersect(&grant.branch_scope),
        );
    }
    match &effective {
        BranchScope::Branches(branches) if branches.is_empty() => None,
        _ => Some(effective),
    }
}

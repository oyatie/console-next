use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use console_kernel_core::{BranchId, BranchScope, KernelError, OrgId, UserId};
use sqlx::{PgPool, Postgres, Row, Transaction};

use crate::{
    EffectiveFeatureGrant, Feature, GrantValidity, PermissionLevel, enforce_assignment_non_overlap,
};

#[derive(Debug)]
pub(crate) struct RuntimePolicyPermissionRow {
    /// The `user_role_assignments` row this permission was reached through. A
    /// role with three permissions joins to three rows and is still ONE
    /// assignment; ADR-0032 §1's non-overlap constraint is about assignments.
    pub(crate) assignment_id: uuid::Uuid,
    pub(crate) role_id: uuid::Uuid,
    pub(crate) feature_key: String,
    pub(crate) permission_level: String,
}

#[derive(Debug)]
struct RuntimePolicyConditionRow {
    role_id: uuid::Uuid,
    attribute: String,
    operator: String,
    condition_values: Vec<String>,
}

/// Resolve runtime-effective tenant custom-role grants under an explicitly
/// armed org.
///
/// Safety boundary:
/// * only assignments to `ACTIVE`, non-system roles are effective;
/// * feature/permission strings are parse-or-deny;
/// * elevated/scope-widening features stay system-role-only for this slice;
/// * branch conditions may only narrow the already-live branch scope;
/// * team conditions must match the target user's live team attribute;
/// * unsupported ABAC/PBAC conditions fail closed for runtime authorization
///   while remaining persisted/visible in Policy Studio previews.
pub async fn resolve_effective_feature_grants_in_org(
    pool: &PgPool,
    org: OrgId,
    user_id: UserId,
    live_branch_scope: &BranchScope,
) -> Result<Vec<EffectiveFeatureGrant>, KernelError> {
    let mut tx = pool.begin().await.map_err(map_effective_policy_error)?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(map_effective_policy_error)?;
    let grants =
        resolve_effective_feature_grants_in_tx(&mut tx, org, user_id, live_branch_scope).await?;
    tx.commit().await.map_err(map_effective_policy_error)?;
    Ok(grants)
}

/// Same resolver for an already Company-armed owner transaction. It must not
/// acquire another pooled connection while the caller holds authentication locks.
pub async fn resolve_effective_feature_grants_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user_id: UserId,
    live_branch_scope: &BranchScope,
) -> Result<Vec<EffectiveFeatureGrant>, KernelError> {
    let user_team: Option<String> =
        sqlx::query_scalar("SELECT team FROM users WHERE org_id = $1 AND id = $2")
            .bind(*org.as_uuid())
            .bind(*user_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await
            .map_err(map_effective_policy_error)?
            .flatten();

    let permission_rows = sqlx::query(
        r#"
        SELECT ura.id AS assignment_id, pr.id AS role_id, prp.feature_key, prp.permission_level
        FROM user_role_assignments AS ura
        JOIN policy_roles AS pr
          ON pr.org_id = ura.org_id
         AND pr.id = ura.role_id
        JOIN policy_role_permissions AS prp
          ON prp.org_id = pr.org_id
         AND prp.role_id = pr.id
        WHERE ura.org_id = $1
          AND ura.user_id = $2
          AND pr.status = 'ACTIVE'
          AND pr.is_system = false
        ORDER BY pr.role_key, prp.feature_key
        "#,
    )
    .bind(*org.as_uuid())
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await
    .map_err(map_effective_policy_error)?
    .into_iter()
    .map(|row| {
        Ok(RuntimePolicyPermissionRow {
            assignment_id: row.try_get("assignment_id")?,
            role_id: row.try_get("role_id")?,
            feature_key: row.try_get("feature_key")?,
            permission_level: row.try_get("permission_level")?,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()
    .map_err(map_effective_policy_error)?;

    let role_ids = permission_rows
        .iter()
        .map(|row| row.role_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let condition_rows = if role_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            r#"
            SELECT role_id, attribute, operator, condition_values
            FROM policy_role_conditions
            WHERE org_id = $1
              AND role_id = ANY($2)
            ORDER BY role_id, condition_key
            "#,
        )
        .bind(*org.as_uuid())
        .bind(&role_ids)
        .fetch_all(tx.as_mut())
        .await
        .map_err(map_effective_policy_error)?
        .into_iter()
        .map(|row| {
            Ok(RuntimePolicyConditionRow {
                role_id: row.try_get("role_id")?,
                attribute: row.try_get("attribute")?,
                operator: row.try_get("operator")?,
                condition_values: row.try_get("condition_values")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(map_effective_policy_error)?
    };

    let mut conditions_by_role: BTreeMap<uuid::Uuid, Vec<RuntimePolicyConditionRow>> =
        BTreeMap::new();
    for condition in condition_rows {
        conditions_by_role
            .entry(condition.role_id)
            .or_default()
            .push(condition);
    }

    let mut effective_scopes_by_role = BTreeMap::new();
    for role_id in role_ids {
        let Some(scope) = effective_scope_for_custom_role_conditions(
            live_branch_scope,
            user_team.as_deref(),
            conditions_by_role
                .get(&role_id)
                .map_or(&[][..], Vec::as_slice),
        ) else {
            continue;
        };
        if !scope.is_empty() {
            effective_scopes_by_role.insert(role_id, scope);
        }
    }

    effective_grants_from_checked_assignments(permission_rows, &effective_scopes_by_role)
}

/// One entry per 발령, for [`enforce_assignment_non_overlap`] to group by role.
///
/// The permission join repeats one assignment once per permission, so the rows
/// are folded by ASSIGNMENT id. Keying this by `role_id` instead reads as a
/// tidy-up and is not one: two records for a role would collapse into one entry
/// and the guard downstream could never fire again.
///
/// Every interval is [`GrantValidity::always()`] because
/// `user_role_assignments` has no `valid_from`/`valid_to` columns yet — the
/// migration is ADR-0032's other half. That is not a placeholder that weakens
/// the check today: `always()` overlaps `always()`, so two rows for one role
/// are still refused.
///
/// It is NOT, however, the shape the columns arrive in. When they land, THIS
/// function must read them; leaving `always()` here would fold two legitimately
/// consecutive 발령 — `[100, 200)` then `[200, 300)`, the case
/// `touching_half_open_intervals_for_one_role_do_not_overlap` exists to permit —
/// into two `always()` intervals that overlap, and the resolver would return
/// `Conflict` instead of that user's whole custom-role authority.
///
/// That obligation is executable, not a note: the integration test
/// `assignment_validity_is_stamped_only_while_the_schema_has_no_intervals`
/// asserts against the live schema that the columns are absent, so the
/// migration that adds them fails here first and names this function.
pub(crate) fn assignment_validities(
    permission_rows: &[RuntimePolicyPermissionRow],
) -> Vec<(uuid::Uuid, GrantValidity)> {
    permission_rows
        .iter()
        .map(|row| (row.assignment_id, row.role_id))
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .map(|role_id| (role_id, GrantValidity::always()))
        .collect()
}

/// The fold from assignment rows to runtime authority — behind ADR-0032 §1.
///
/// The check is FIRST and the fold is only reachable through it, so an
/// ambiguous assignment set cannot become a grant by a caller forgetting to
/// ask. `enforce_assignment_non_overlap` is otherwise a predicate with no
/// production caller, which is indistinguishable from not having one.
///
/// The checked set is derived HERE, from the same rows that are about to be
/// folded. It was a separate argument, and that made the wiring provable only
/// by inspection: the resolver could pass an empty slice — accidentally, or
/// through an edit to what it collected — and the guard would still be called,
/// still return `Ok`, and no test could tell, because the assignments a test
/// passes are not the rows it folds. One argument means the two cannot be
/// different sets.
///
/// The rows checked are the ones that are about to become authority:
/// assignments to ACTIVE, non-system roles that carry a permission. A duplicate
/// on a DRAFT role grants nothing either way, and the database constraint (still
/// unwritten) covers the rest.
///
/// # Errors
///
/// [`console_kernel_core::ErrorKind::Conflict`] when two assignments of one role
/// cover a shared instant.
pub(crate) fn effective_grants_from_checked_assignments(
    permission_rows: Vec<RuntimePolicyPermissionRow>,
    effective_scopes_by_role: &BTreeMap<uuid::Uuid, BranchScope>,
) -> Result<Vec<EffectiveFeatureGrant>, KernelError> {
    enforce_assignment_non_overlap(&assignment_validities(&permission_rows))?;

    Ok(permission_rows
        .into_iter()
        .filter_map(|row| {
            let scope = effective_scopes_by_role.get(&row.role_id)?;
            let feature = Feature::from_str(&row.feature_key).ok()?;
            let permission = PermissionLevel::from_str(&row.permission_level).ok()?;
            if permission == PermissionLevel::Deny || !custom_role_runtime_feature_allowed(feature)
            {
                return None;
            }
            Some(EffectiveFeatureGrant::new(
                feature,
                permission,
                scope.clone(),
            ))
        })
        .collect())
}

/// Single safety predicate for features a custom role may grant at runtime.
///
/// Used by [`effective_grants_from_checked_assignments`] and by identity REST
/// write/preview/assignment ceilings. Callers must not re-encode this block
/// list. Policy Studio catalog visibility is a separate UI concern in
/// `console-identity-rest` (`policy_studio_feature_visible`).
#[must_use]
pub fn custom_role_runtime_feature_allowed(feature: Feature) -> bool {
    !matches!(
        feature,
        Feature::RoleManage
            | Feature::ElevatedRoleGrant
            | Feature::OrgWideQueueTriage
            | Feature::AuditStreamRead
            | Feature::AuditStreamAccessLogRead
            | Feature::AiAssist
            // PREREG-2: Cedar-only governance features. A custom role never
            // carries them; only their per-action Cedar schemas can allow.
            | Feature::SettingsManage
            | Feature::ReasonCodeManage
            | Feature::ExceptionDecide
            | Feature::ApprovalRouteManage
            | Feature::ChangeRequestDecide
            | Feature::JobTitleManage
            | Feature::RetainedRecordsRead
            | Feature::TenantOffboard
            | Feature::LegalEntityManage
            | Feature::OrgUnitManage
    )
}

fn effective_scope_for_custom_role_conditions(
    live_branch_scope: &BranchScope,
    user_team: Option<&str>,
    conditions: &[RuntimePolicyConditionRow],
) -> Option<BranchScope> {
    let mut scope = live_branch_scope.clone();
    for condition in conditions {
        if !matches!(condition.operator.as_str(), "equals" | "in") {
            return None;
        }

        match condition.attribute.as_str() {
            "branch" => {
                let mut branches = BTreeSet::new();
                for value in &condition.condition_values {
                    let Ok(branch) = BranchId::from_str(value) else {
                        return None;
                    };
                    branches.insert(branch);
                }
                scope = scope.intersect(&BranchScope::Branches(branches));
            }
            "team" => {
                if !team_condition_matches(user_team, &condition.condition_values) {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(scope)
}

fn team_condition_matches(user_team: Option<&str>, values: &[String]) -> bool {
    let Some(user_team) = user_team.map(str::trim).filter(|team| !team.is_empty()) else {
        return false;
    };
    let Some(accepted) = team_policy_values(user_team) else {
        return false;
    };
    values.iter().any(|value| {
        let value = value.trim();
        accepted
            .iter()
            .any(|accepted| value == *accepted || value.eq_ignore_ascii_case(accepted))
    })
}

fn team_policy_values(user_team: &str) -> Option<[&'static str; 2]> {
    match user_team {
        "정비" => Some(["MAINTENANCE", "정비"]),
        "예방" => Some(["PREVENTION", "예방"]),
        "관리" => Some(["MANAGEMENT", "관리"]),
        "접수" => Some(["RECEPTION", "접수"]),
        _ => None,
    }
}

fn map_effective_policy_error(err: sqlx::Error) -> KernelError {
    KernelError::internal(format!("failed to resolve effective policy: {err}"))
}

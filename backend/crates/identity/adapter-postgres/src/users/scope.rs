use crate::PgOrgError;
use crate::users::rows::fetch_user_branch_uuid_ids_tx;
use console_kernel_core::{BranchId, BranchScope, KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::BTreeSet;

/// Live BranchScope for the acting administrator, matching
/// `resolve_branch_scope_in_org`: SUPER_ADMIN/EXECUTIVE → `All`; otherwise the
/// actor's `user_branches` set. Resolved inside the armed write tx so a revoked
/// membership cannot race past the gate. Missing actor → forbidden (fail closed).
pub(crate) async fn resolve_actor_branch_scope_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
) -> Result<BranchScope, PgOrgError> {
    let roles: Option<Vec<String>> = sqlx::query_scalar("SELECT roles FROM users WHERE id = $1")
        .bind(*actor.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?;
    let Some(roles) = roles else {
        return Err(PgOrgError::Domain(KernelError::forbidden(
            "actor is not an active identity principal",
        )));
    };
    if roles
        .iter()
        .any(|role| role == "SUPER_ADMIN" || role == "EXECUTIVE")
    {
        return Ok(BranchScope::All);
    }
    let branch_ids: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*actor.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    Ok(BranchScope::Branches(
        branch_ids.into_iter().map(BranchId::from_uuid).collect(),
    ))
}

/// Fail closed when a `user_branches` replace would touch any branch outside
/// `actor_scope`. Touched = union(current, requested) so removals and additions
/// are both gated at the store write (console-o498). This is adapter
/// defense-in-depth under REST; REST `authorize_user_write` still iterates the
/// requested/target branch list only — the adapter gate is intentionally
/// stricter on removals. `BranchScope::All` short-circuits.
fn ensure_branch_rewrite_in_scope(
    actor_scope: &BranchScope,
    current_branch_ids: &[uuid::Uuid],
    requested_branch_ids: &[uuid::Uuid],
) -> Result<(), PgOrgError> {
    if matches!(actor_scope, BranchScope::All) {
        return Ok(());
    }
    let mut touched = BTreeSet::new();
    for id in current_branch_ids.iter().chain(requested_branch_ids.iter()) {
        touched.insert(*id);
    }
    for id in touched {
        if !actor_scope.allows(BranchId::from_uuid(id)) {
            return Err(PgOrgError::Domain(KernelError::forbidden(
                "not allowed to manage users in that branch",
            )));
        }
    }
    Ok(())
}

pub(crate) async fn replace_user_branches(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    branch_ids: &[uuid::Uuid],
    org_uuid: uuid::Uuid,
    actor_scope: &BranchScope,
) -> Result<(), PgOrgError> {
    // Read live memberships BEFORE the DELETE so removals are in the touched
    // union. Without this, a Branches({A}) actor could drop B by rewriting to
    // [A] alone (REST-only gate would be the sole backstop — console-o498).
    let current_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
    ensure_branch_rewrite_in_scope(actor_scope, &current_branch_ids, branch_ids)?;

    sqlx::query("DELETE FROM user_branches WHERE user_id = $1")
        .bind(*user_id.as_uuid())
        .execute(tx.as_mut())
        .await?;
    for branch_id in branch_ids {
        sqlx::query(
            "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3) \
             ON CONFLICT (user_id, branch_id) DO NOTHING",
        )
        .bind(*user_id.as_uuid())
        .bind(branch_id)
        .bind(org_uuid)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

pub(crate) async fn user_in_scope(
    pool: &PgPool,
    user_id: UserId,
    scope: &BranchScope,
) -> Result<bool, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    match scope {
        BranchScope::All => {
            let exists: Option<uuid::Uuid> =
                with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
                    Box::pin(async move {
                        Ok(sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                            .bind(*user_id.as_uuid())
                            .fetch_optional(tx.as_mut())
                            .await?)
                    })
                })
                .await?;
            Ok(exists.is_some())
        }
        BranchScope::Branches(branches) if branches.is_empty() => Ok(false),
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> = branches.iter().map(|b| *b.as_uuid()).collect();
            let found: Option<uuid::Uuid> =
                with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
                    Box::pin(async move {
                        Ok(sqlx::query_scalar(
                            "SELECT user_id FROM user_branches WHERE user_id = $1 AND branch_id = ANY($2) LIMIT 1",
                        )
                        .bind(*user_id.as_uuid())
                        .bind(&branch_ids)
                        .fetch_optional(tx.as_mut())
                        .await?)
                    })
                })
                .await?;
            Ok(found.is_some())
        }
    }
}

#[cfg(test)]
mod ensure_branch_rewrite_in_scope_tests {
    use super::*;
    use crate::users::rows::{USER_SELECT_DIRECTORY, USER_SELECT_WITH_PASSKEY};
    use console_kernel_core::ErrorKind;

    /// console-o498: Branches({A}) must not drop U from B by rewriting to [A].
    #[test]
    fn refuses_branch_removal_outside_caller_scope() {
        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let scope = BranchScope::single(branch_a);
        let current = vec![*branch_a.as_uuid(), *branch_b.as_uuid()];
        let requested = vec![*branch_a.as_uuid()];
        let err = ensure_branch_rewrite_in_scope(&scope, &current, &requested)
            .expect_err("removing B outside actor scope must fail closed");
        assert_eq!(err.kind(), ErrorKind::Forbidden);
    }

    #[test]
    fn allows_in_scope_membership_rewrite() {
        let branch_a = BranchId::new();
        let scope = BranchScope::single(branch_a);
        let current = vec![*branch_a.as_uuid()];
        let requested = vec![*branch_a.as_uuid()];
        ensure_branch_rewrite_in_scope(&scope, &current, &requested)
            .expect("in-scope rewrite must pass");
    }

    #[test]
    fn still_refuses_branch_addition_outside_caller_scope() {
        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let scope = BranchScope::single(branch_a);
        let current = vec![*branch_a.as_uuid()];
        let requested = vec![*branch_a.as_uuid(), *branch_b.as_uuid()];
        let err = ensure_branch_rewrite_in_scope(&scope, &current, &requested)
            .expect_err("adding B outside actor scope must fail closed");
        assert_eq!(err.kind(), ErrorKind::Forbidden);
    }

    #[test]
    fn all_scope_allows_cross_branch_rewrite() {
        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let current = vec![*branch_a.as_uuid(), *branch_b.as_uuid()];
        let requested = vec![*branch_a.as_uuid()];
        ensure_branch_rewrite_in_scope(&BranchScope::All, &current, &requested)
            .expect("BranchScope::All must not gate membership rewrites");
        let directory_sql = USER_SELECT_DIRECTORY.to_ascii_lowercase();
        for fragment in ["phone", "salary", "bank", "rrn"] {
            assert!(
                !directory_sql.contains(fragment),
                "directory hydration must not mention {fragment}"
            );
        }
        assert!(
            USER_SELECT_WITH_PASSKEY.contains("account.phone"),
            "get_user / list_users must keep reading users.phone"
        );
    }
}

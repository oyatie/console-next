use crate::users::rows::fetch_user;
use crate::users::scope::user_in_scope;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{UserListQuery, UserPage, UserSummary};
use console_kernel_core::{BranchScope, KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{Postgres, QueryBuilder};

pub(crate) const DEFAULT_USER_LIMIT: i64 = 50;
const MAX_USER_LIMIT: i64 = 200;

impl PgOrgStore {
    /// Fetch a single user by id, restricted to the caller's branch scope.
    pub async fn get_user(
        &self,
        user_id: UserId,
        scope: &BranchScope,
    ) -> Result<UserSummary, PgOrgError> {
        if !user_in_scope(&self.pool, user_id, scope).await? {
            return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
        }
        fetch_user(&self.pool, user_id).await
    }

    /// List users visible within the caller's branch scope, as one page plus the
    /// unpaged `total` for that scope so the console can page beyond the cap and
    /// show an honest count.
    pub async fn list_users(
        &self,
        scope: &BranchScope,
        query: UserListQuery,
    ) -> Result<UserPage, PgOrgError> {
        let limit = query
            .limit
            .unwrap_or(DEFAULT_USER_LIMIT)
            .clamp(1, MAX_USER_LIMIT);
        let offset = query.offset.unwrap_or(0).max(0);

        // The branch-scope + active filter is shared by the id page and the
        // COUNT, so build it once into a closure that appends to any builder.
        let scope = scope.clone();
        let include_inactive = query.include_inactive;
        let independence_review_required = query.independence_review_required;
        let push_filter = move |builder: &mut QueryBuilder<Postgres>| {
            match &scope {
                BranchScope::All => {
                    builder.push("TRUE");
                }
                BranchScope::Branches(branches) if branches.is_empty() => {
                    builder.push("FALSE");
                }
                BranchScope::Branches(branches) => {
                    let branch_ids: Vec<uuid::Uuid> =
                        branches.iter().map(|b| *b.as_uuid()).collect();
                    builder
                        .push(
                            "EXISTS (SELECT 1 FROM user_branches ub \
                             WHERE ub.user_id = u.id AND ub.branch_id = ANY(",
                        )
                        .push_bind(branch_ids)
                        .push("))");
                }
            }
            if independence_review_required {
                builder.push(
                    " AND NOT EXISTS (SELECT 1 FROM employee_person_bindings b \
                    WHERE b.org_id=u.org_id AND b.employee_id=u.employee_id) \
                    AND EXISTS (SELECT 1 FROM audit_events a WHERE a.org_id=u.org_id AND \
                    (a.decision_snapshot->>'sod.maker.account'=u.id::text OR \
                     a.decision_snapshot->>'sod.checker.account'=u.id::text))",
                );
            }
            if !include_inactive {
                builder.push(" AND u.is_active = true");
            }
        };

        let mut count_builder =
            QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM users u WHERE ");
        push_filter(&mut count_builder);

        let mut builder = QueryBuilder::<Postgres>::new("SELECT id FROM users u WHERE ");
        push_filter(&mut builder);
        builder
            .push(" ORDER BY u.created_at DESC, u.id DESC LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(offset);

        let org = current_org().map_err(KernelError::from)?;
        let (total, ids) =
            with_org_conn::<_, (i64, Vec<uuid::Uuid>), PgOrgError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let total: i64 = count_builder
                        .build_query_scalar::<i64>()
                        .fetch_one(tx.as_mut())
                        .await?;
                    let ids = builder
                        .build_query_scalar::<uuid::Uuid>()
                        .fetch_all(tx.as_mut())
                        .await?;
                    Ok((total, ids))
                })
            })
            .await?;

        let mut items = Vec::with_capacity(ids.len());
        for id in ids {
            items.push(fetch_user(&self.pool, UserId::from_uuid(id)).await?);
        }
        Ok(UserPage {
            items,
            limit,
            offset,
            total,
        })
    }
}

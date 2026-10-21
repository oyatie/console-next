use crate::users::read::DEFAULT_USER_LIMIT;
use crate::users::rows::fetch_directory_user;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{DirectoryListQuery, MAX_DIRECTORY_PAGE_LIMIT, UserPage};
use console_kernel_core::{BranchScope, KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{Postgres, QueryBuilder};

impl PgOrgStore {
    /// List people visible to a directory reader. Every filter is applied to
    /// both the count and page query, so `total` is the exact size of the
    /// filtered effective branch scope.
    pub async fn list_directory_people(
        &self,
        scope: &BranchScope,
        query: DirectoryListQuery,
    ) -> Result<UserPage, PgOrgError> {
        let limit = query
            .limit
            .unwrap_or(DEFAULT_USER_LIMIT)
            .clamp(1, MAX_DIRECTORY_PAGE_LIMIT);
        let offset = query.offset.unwrap_or(0).max(0);
        // A requested branch is not an additional SQL predicate: it narrows
        // the effective authorization scope itself. Keeping the two EXISTS
        // predicates independent would admit a user that belongs to both an
        // allowed branch and the requested-but-forbidden branch, leaking the
        // identity and count through the latter filter.
        let scope = query.branch_id.map_or_else(
            || scope.clone(),
            |branch_id| scope.intersect(&BranchScope::single(branch_id)),
        );
        let result_scope = scope.clone();
        let search = query.search;
        let team = query.team;
        let roles = query.roles;
        let include_inactive = query.include_inactive;

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
                        branches.iter().map(|branch| *branch.as_uuid()).collect();
                    builder
                        .push(
                            "EXISTS (SELECT 1 FROM user_branches ub \
                             WHERE ub.user_id = u.id AND ub.branch_id = ANY(",
                        )
                        .push_bind(branch_ids)
                        .push("))");
                }
            }
            if let Some(search) = &search {
                // Display name, the employee number of the linked employee
                // record (0076 explicit link; same tenant by FK and RLS), or
                // any 아이디 the account holds or held (#33: an old one stays
                // a searchable alias for good).
                builder
                    .push(" AND (LOWER(u.display_name) LIKE '%' || ")
                    .push_bind(search.clone())
                    .push(
                        " || '%' OR EXISTS (SELECT 1 FROM employees e \
                         WHERE e.id = u.employee_id AND e.org_id = u.org_id \
                           AND LOWER(e.employee_number) LIKE '%' || ",
                    )
                    .push_bind(search.clone())
                    .push(
                        " || '%') OR EXISTS (SELECT 1 FROM user_sign_in_ids s \
                         WHERE s.org_id = u.org_id AND s.user_id = u.id \
                           AND s.login LIKE '%' || split_part(",
                    )
                    .push_bind(search.clone())
                    .push(", '@', 1) || '%'))");
            }
            if let Some(team) = team {
                builder.push(" AND u.team = ").push_bind(team.as_db_str());
            }
            if !roles.is_empty() {
                builder.push(" AND u.roles && ").push_bind(roles.clone());
            }
            if !include_inactive {
                builder.push(" AND u.is_active = true");
            }
        };

        let mut count_builder =
            QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM users u WHERE ");
        push_filter(&mut count_builder);

        let mut page_builder = QueryBuilder::<Postgres>::new("SELECT id FROM users u WHERE ");
        push_filter(&mut page_builder);
        // No deployment pins the database collation (neither the CI service nor
        // deploy/apps/console/base/database.yaml sets one), so an unqualified
        // ORDER BY display_name pages differently per environment. "und-x-icu"
        // is the ICU root locale: identical on every server AND still the
        // human-readable name order a directory needs. Do not swap it for "C",
        // which is byte order and would file every uppercase and every Hangul
        // name away from where a reader looks for it.
        page_builder
            .push(" ORDER BY u.display_name COLLATE \"und-x-icu\" ASC, u.id ASC LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(offset);

        let org = current_org().map_err(KernelError::from)?;
        let (total, ids) =
            with_org_conn::<_, (i64, Vec<uuid::Uuid>), PgOrgError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let total = count_builder
                        .build_query_scalar::<i64>()
                        .fetch_one(tx.as_mut())
                        .await?;
                    let ids = page_builder
                        .build_query_scalar::<uuid::Uuid>()
                        .fetch_all(tx.as_mut())
                        .await?;
                    Ok((total, ids))
                })
            })
            .await?;

        let mut items = Vec::with_capacity(ids.len());
        for id in ids {
            // fetch_user SELECTs users.phone; directory pages must not.
            let mut user = fetch_directory_user(&self.pool, UserId::from_uuid(id)).await?;
            user.branch_ids
                .retain(|branch| result_scope.allows(*branch));
            items.push(user);
        }
        Ok(UserPage {
            items,
            limit,
            offset,
            total,
        })
    }
}

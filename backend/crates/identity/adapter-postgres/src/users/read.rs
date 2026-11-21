use crate::users::rows::fetch_user;
use crate::users::rows::fetch_user_tx;
use crate::users::rows_batch::fetch_users_by_ids_tx;
use crate::users::scope::user_in_scope;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{UserListQuery, UserPage, UserSummary};
use console_kernel_core::{BranchId, BranchScope, KernelError, UserId};
use console_platform_authz::access::{
    AccessSlice, Domain, Level, NodePath, action_group, load_access_subject,
};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{Postgres, QueryBuilder, Row, Transaction};

pub(crate) const DEFAULT_USER_LIMIT: i64 = 50;
const MAX_USER_LIMIT: i64 = 200;

impl PgOrgStore {
    /// Access-screen account detail: the same tenant-wide Cedar read as effective access.
    pub async fn get_access_person(
        &self,
        actor: UserId,
        user_id: UserId,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let subject =
                    load_access_subject(tx, org, *actor.as_uuid(), time::OffsetDateTime::now_utc())
                        .await
                        .map_err(|error| {
                            tracing::error!(%error, "access account facts unavailable");
                            KernelError::internal("access authorization is unavailable")
                        })?;
                let allowed = AccessSlice::compile(&subject)
                    .and_then(|slice| {
                        slice.allows(
                            &action_group(Domain::Access, Level::View),
                            &NodePath::tenant(org),
                        )
                    })
                    .map_err(|error| tracing::warn!(%error, "access account read denied"))
                    .unwrap_or(false);
                if !allowed {
                    return Err(KernelError::forbidden("access account read is denied")
                        .with_code("access_denied")
                        .into());
                }
                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }

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

    /// Fetch the caller's own [`UserSummary`] enriched with self-service
    /// employee employment metadata (`hire_date`, `employment_status`, `grade`).
    pub async fn get_me_summary(&self, user_id: UserId) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut summary = fetch_user_tx(tx, user_id).await?;
                if let Some(employee_id) = summary.employee_id {
                    let (hire_date, employment_status, grade) =
                        fetch_employee_summary_extras_tx(tx, *org.as_uuid(), employee_id).await?;
                    summary.employee_hire_date = hire_date;
                    summary.employee_employment_status = employment_status;
                    summary.employee_grade = grade;
                }
                Ok(summary)
            })
        })
        .await
    }

    /// Employee `id`'s live home branch; `None` when it has none, or no such employee.
    pub async fn employee_home_branch(
        &self,
        id: uuid::Uuid,
    ) -> Result<Option<BranchId>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let branch: Option<uuid::Uuid> = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT b.id FROM employees e JOIN branches b \
                     ON b.org_id = e.org_id AND b.id = e.home_branch_id AND b.deactivated_at IS NULL \
                     WHERE e.org_id = $1 AND e.id = $2",
                )
                .bind(org.as_uuid())
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;
        Ok(branch.map(BranchId::from_uuid))
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

        // The branch-scope + active + search filter is shared by the id page and the
        // COUNT, so build it once into a closure that appends to any builder.
        let scope = scope.clone();
        let include_inactive = query.include_inactive;
        let search = query
            .search
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty());
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
            if !include_inactive {
                builder.push(" AND u.is_active = true");
            }
            if let Some(search) = &search {
                let escaped = escape_like(search);
                let login_part = escape_like(search.split('@').next().unwrap_or(search));
                builder
                    .push(
                        " AND (EXISTS (SELECT 1 FROM person_accounts_current pa \
                         WHERE pa.org_id = u.org_id AND pa.id = u.id \
                           AND LOWER(pa.display_name) LIKE '%' || ",
                    )
                    .push_bind(escaped.clone())
                    .push(
                        " || '%' ESCAPE '\\') OR EXISTS (SELECT 1 FROM employees e \
                         WHERE e.id = u.employee_id AND e.org_id = u.org_id \
                           AND LOWER(e.employee_number) LIKE '%' || ",
                    )
                    .push_bind(escaped)
                    .push(" || '%' ESCAPE '\\')");
                if !login_part.is_empty() {
                    builder
                        .push(
                            " OR EXISTS (SELECT 1 FROM user_sign_in_ids s \
                             WHERE s.org_id = u.org_id AND s.user_id = u.id \
                               AND s.login LIKE '%' || ",
                        )
                        .push_bind(login_part)
                        .push(" || '%' ESCAPE '\\')");
                }
                builder.push(")");
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
        let (total, items) =
            with_org_conn::<_, (i64, Vec<UserSummary>), PgOrgError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let total: i64 = count_builder
                        .build_query_scalar::<i64>()
                        .fetch_one(tx.as_mut())
                        .await?;
                    let ids = builder
                        .build_query_scalar::<uuid::Uuid>()
                        .fetch_all(tx.as_mut())
                        .await?;
                    let items = fetch_users_by_ids_tx(tx, &ids).await?;
                    Ok((total, items))
                })
            })
            .await?;

        Ok(UserPage {
            items,
            limit,
            offset,
            total,
        })
    }
}

pub(crate) fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

async fn fetch_employee_summary_extras_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: uuid::Uuid,
    employee_id: uuid::Uuid,
) -> Result<(Option<String>, Option<String>, Option<String>), PgOrgError> {
    let row = sqlx::query(
        "SELECT COALESCE(to_char(e.hire_on, 'YYYY-MM-DD'), NULLIF(btrim(e.hire_date), '')) AS hire_date, \
                entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS employment_status, \
                jt.label AS grade \
         FROM employees e \
         LEFT JOIN job_titles jt \
           ON jt.org_id = e.org_id AND jt.id = e.grade_id AND jt.kind = 'GRADE' \
         WHERE e.org_id = $1 AND e.id = $2",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Ok((None, None, None));
    };
    Ok((
        row.try_get("hire_date")?,
        row.try_get("employment_status")?,
        row.try_get("grade")?,
    ))
}

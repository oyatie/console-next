// SPDX-License-Identifier: LicenseRef-Proprietary
//! Whom a requester may ask: the accounts placed under a node where Cedar
//! permits the requester's `todo_assign`. The picker and the ask read the same
//! fragment, as the list and single-row forms of one rule, so they cannot drift.

use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_authz::Feature;
use console_platform_authz::cedar_pbac::visible::{EmployeeVisibility, load_facts};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use console_todos_application::{ListTodoAssigneesQuery, TodoAssignee, TodoAssigneePage};
use sqlx::{Postgres, QueryBuilder, Row, Transaction};
use uuid::Uuid;

use crate::{PgTodoError, PgTodoStore};

/// The requester's reach, decided by Cedar in this transaction. A Cedar
/// failure is an internal error, never an allow.
pub(crate) async fn reach(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    requester: UserId,
) -> Result<EmployeeVisibility, PgTodoError> {
    let facts = load_facts(tx, org, *requester.as_uuid()).await?;
    facts
        .visible_employees(Feature::TodoAssign.as_str())
        .map_err(|e| KernelError::internal(format!("request reach unavailable: {e}")).into())
}

/// Continues a query that has just aliased an account table as `u`: its
/// linked employee's current placement, then the tenant and the reach.
/// An account with no linked employee or placement sits at the tenant node.
pub(crate) fn push_reach(q: &mut QueryBuilder<Postgres>, org: Uuid, vis: &EmployeeVisibility) {
    q.push(
        " LEFT JOIN employees e ON e.org_id = u.org_id AND e.id = u.employee_id \
         LEFT JOIN employment_resolved_assignments ea \
         ON ea.org_id = e.org_id AND ea.employee_id = e.id WHERE u.org_id = ",
    );
    q.push_bind(org);
    q.push(" AND ");
    vis.push(q);
}

impl PgTodoStore {
    /// The active accounts the requester may ask, by name, without itself.
    pub async fn list_assignees(
        &self,
        query: ListTodoAssigneesQuery,
    ) -> Result<TodoAssigneePage, PgTodoError> {
        let org = current_org().map_err(KernelError::from)?;
        let search = query
            .search
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let limit = query.limit.clamp(1, 50);
        let requester = query.requester;
        let rows = with_org_conn::<_, _, PgTodoError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let vis = reach(tx, org, requester).await?;
                let mut q =
                    QueryBuilder::new("SELECT u.id, u.display_name FROM person_accounts_current u");
                push_reach(&mut q, *org.as_uuid(), &vis);
                q.push(" AND u.is_active AND u.id <> ");
                q.push_bind(*requester.as_uuid());
                if let Some(search) = search {
                    q.push(" AND LOWER(u.display_name) LIKE '%' || ");
                    q.push_bind(search);
                    q.push(" || '%'");
                }
                // The directory's collation: the same name order on every server.
                q.push(" ORDER BY u.display_name COLLATE \"und-x-icu\" ASC, u.id ASC LIMIT ");
                q.push_bind(limit);
                Ok(q.build().fetch_all(tx.as_mut()).await?)
            })
        })
        .await?;
        let items = rows
            .iter()
            .map(|row| {
                Ok(TodoAssignee {
                    account_id: UserId::from_uuid(row.try_get("id")?),
                    display_name: row.try_get("display_name")?,
                })
            })
            .collect::<Result<_, sqlx::Error>>()?;
        Ok(TodoAssigneePage { items })
    }
}

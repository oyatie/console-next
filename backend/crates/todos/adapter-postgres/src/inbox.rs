// SPDX-License-Identifier: LicenseRef-Proprietary
//! The work inbox's two views of a request: the assignee's open request and
//! the requester's open or returned one. Each predicate names the caller's own
//! account, so nobody else reads the row; done and withdrawn requests leave both.

use console_kernel_core::{OrgId, UserId};
use console_platform_db::with_org_conn;
use console_todos_application::TodoSummary;
use sqlx::{Postgres, QueryBuilder, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{PgTodoError, PgTodoStore, summary_from_row};

/// Which side of a request the caller is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboxRole {
    /// The assignee, who owes an open request.
    Assigned,
    /// The requester, who follows what they asked, open or sent back.
    Requested,
}

impl InboxRole {
    /// The inbox id prefix; the keyset compares `prefix || id`.
    #[must_use]
    pub fn id_prefix(self) -> &'static str {
        match self {
            Self::Assigned => "todo_assigned:",
            Self::Requested => "todo_requested:",
        }
    }
}

#[derive(Debug)]
pub struct TodoInboxItem {
    pub todo: TodoSummary,
    /// The end of the due day in Korea.
    pub due: Option<OffsetDateTime>,
    /// The other party's display name: the requester's for the assignee, the assignee's for the requester.
    pub other_name: Option<String>,
}

#[derive(Debug)]
pub struct TodoInboxPage {
    pub items: Vec<TodoInboxItem>,
    pub total: i64,
    pub has_more: bool,
}

impl PgTodoStore {
    /// One keyset page of the caller's requests on one side, in the inbox order
    /// (due first, undated last), with the exact total under the same predicate,
    /// from one statement and so one snapshot. The total arrives even on an
    /// empty continuation page.
    pub async fn inbox_page(
        &self,
        org: OrgId,
        me: UserId,
        role: InboxRole,
        as_of: OffsetDateTime,
        after: Option<(Option<OffsetDateTime>, OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<TodoInboxPage, PgTodoError> {
        let limit = limit.clamp(1, 200);
        let (org_uuid, me) = (*org.as_uuid(), *me.as_uuid());
        let (item_id, other, side) = match role {
            InboxRole::Assigned => (
                "('todo_assigned:' || id::text)",
                "assigned_by_user_id",
                " AND assigned_by_user_id IS NOT NULL AND returned_at IS NULL AND owner_user_id = ",
            ),
            InboxRole::Requested => (
                "('todo_requested:' || id::text)",
                "owner_user_id",
                " AND assigned_by_user_id = ",
            ),
        };
        with_org_conn::<_, _, PgTodoError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut q =
                    QueryBuilder::<Postgres>::new(concat!("WITH mine AS (SELECT ", columns!()));
                q.push(", ((due_on + TIME '23:59:59.999999') AT TIME ZONE 'Asia/Seoul') AS due, ")
                    .push(item_id)
                    .push(" AS item_id, ")
                    .push(other)
                    .push(" AS other FROM todos WHERE org_id = ")
                    .push_bind(org_uuid)
                    .push(" AND NOT done AND created_at <= ")
                    .push_bind(as_of)
                    .push(side)
                    .push_bind(me)
                    .push("), page AS (SELECT * FROM mine WHERE TRUE");
                console_platform_db::inbox::push_page(
                    &mut q,
                    "due",
                    "created_at",
                    "item_id",
                    after,
                    limit,
                );
                q.push(
                    ") SELECT (SELECT count(*) FROM mine) AS total, page.*, \
                     (SELECT p.display_name FROM person_accounts_current p WHERE p.org_id = ",
                )
                .push_bind(org_uuid)
                .push(
                    " AND p.id = page.other) AS other_name FROM (SELECT 1) AS one \
                     LEFT JOIN page ON TRUE \
                     ORDER BY page.due ASC NULLS LAST, page.created_at ASC, page.item_id ASC",
                );
                let rows = q.build().fetch_all(tx.as_mut()).await?;
                let total = rows
                    .first()
                    .map(|row| row.try_get::<i64, _>("total"))
                    .transpose()?
                    .unwrap_or(0);
                let mut items = Vec::with_capacity(rows.len());
                for row in &rows {
                    // The one row of an empty page carries the total and no request.
                    if row.try_get::<Option<Uuid>, _>("id")?.is_none() {
                        continue;
                    }
                    items.push(TodoInboxItem {
                        todo: summary_from_row(row)?,
                        due: row.try_get("due")?,
                        other_name: row.try_get("other_name")?,
                    });
                }
                let page_size = usize::try_from(limit).unwrap_or(200);
                let has_more = items.len() > page_size;
                items.truncate(page_size);
                Ok(TodoInboxPage {
                    items,
                    total,
                    has_more,
                })
            })
        })
        .await
    }
}

// SPDX-License-Identifier: LicenseRef-Proprietary
//! Bounded task pages share visibility while each consumer retains its ordering.
use super::{
    PgWorkflowRuntimeError, PgWorkflowRuntimeStore, WaitingTaskListFilter, WaitingTaskListItem,
};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_db::{inbox::push_page, with_org_conn};
use console_workflow_domain::WaitingTaskStatus;
use sqlx::{Postgres, QueryBuilder, Row};
use time::OffsetDateTime;

impl PgWorkflowRuntimeStore {
    /// Creation-order cursor retained by the bulk approval endpoint.
    pub async fn list_waiting_tasks_action_page(
        &self,
        org: OrgId,
        me: UserId,
        filter: WaitingTaskListFilter,
        as_of: OffsetDateTime,
        after: Option<(OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<(Vec<WaitingTaskListItem>, bool), KernelError> {
        self.list_waiting_tasks_inbox_page::<false>(
            org,
            me,
            filter,
            as_of,
            after.map(|(at, id)| (Some(at), at, id)),
            limit,
        )
        .await
    }

    /// Deadline-order candidate page; the caller still applies its policy guard.
    pub async fn list_waiting_tasks_deadline_page(
        &self,
        org: OrgId,
        me: UserId,
        filter: WaitingTaskListFilter,
        as_of: OffsetDateTime,
        after: Option<(Option<OffsetDateTime>, OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<(Vec<WaitingTaskListItem>, bool), KernelError> {
        self.list_waiting_tasks_inbox_page::<true>(org, me, filter, as_of, after, limit)
            .await
    }

    async fn list_waiting_tasks_inbox_page<const DEADLINE: bool>(
        &self,
        org: OrgId,
        me: UserId,
        filter: WaitingTaskListFilter,
        as_of: OffsetDateTime,
        after: Option<(Option<OffsetDateTime>, OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<(Vec<WaitingTaskListItem>, bool), KernelError> {
        let limit = limit.clamp(1, 200);
        let statuses = filter
            .statuses
            .iter()
            .map(|status| status.as_db_str().to_owned())
            .collect::<Vec<_>>();
        with_org_conn::<_, (Vec<WaitingTaskListItem>, bool), PgWorkflowRuntimeError>(
            &self.pool,
            org,
            move |tx| {
                Box::pin(async move {
                    let mut query = QueryBuilder::<Postgres>::new(
                        "SELECT t.id AS task_id, t.run_id, t.waiting_key, t.title, \
                            t.assignee_role_key, t.required_policy, t.status, \
                            t.claimed_by, t.due_at, t.created_at, t.form_payload, \
                            r.object_type, r.object_id \
                         FROM workflow_waiting_tasks t \
                         JOIN workflow_runs r ON r.id = t.run_id AND r.org_id = t.org_id \
                         WHERE t.status = ANY(",
                    );
                    query
                        .push_bind(&statuses)
                        .push(") AND (")
                        .push_bind(filter.role_key.as_deref())
                        .push("::text IS NULL OR t.assignee_role_key = ")
                        .push_bind(filter.role_key.as_deref())
                        .push(") AND (NOT ")
                        .push_bind(filter.assignee_me)
                        .push(" OR t.claimed_by = ")
                        .push_bind(*me.as_uuid())
                        .push(" OR (t.status = 'OPEN' AND (t.assignee_role_key = ANY(")
                        .push_bind(&filter.authority_role_keys)
                        .push(") OR (t.assignee_role_key = 'initiator' AND r.initiated_by = ")
                        .push_bind(*me.as_uuid())
                        .push(")))) AND t.created_at <= ")
                        .push_bind(as_of);
                    push_page(
                        &mut query,
                        if DEADLINE { "t.due_at" } else { "t.created_at" },
                        "t.created_at",
                        "('approval:' || t.id::text)",
                        after,
                        limit,
                    );
                    let rows = query.build().fetch_all(tx.as_mut()).await?;
                    let has_more = i64::try_from(rows.len()).unwrap_or(0) > limit;
                    let mut items = rows
                        .iter()
                        .take(usize::try_from(limit).unwrap_or(rows.len()))
                        .map(|row| {
                            let status: String = row.try_get("status")?;
                            Ok(WaitingTaskListItem {
                                task_id: row.try_get("task_id")?,
                                run_id: row.try_get("run_id")?,
                                waiting_key: row.try_get("waiting_key")?,
                                title: row.try_get("title")?,
                                assignee_role_key: row.try_get("assignee_role_key")?,
                                required_policy: row.try_get("required_policy")?,
                                object_type: row.try_get("object_type")?,
                                object_id: row.try_get("object_id")?,
                                status: WaitingTaskStatus::from_db_str(&status)?,
                                claimed_by: row.try_get("claimed_by")?,
                                due_at: row.try_get("due_at")?,
                                created_at: row.try_get("created_at")?,
                                form_payload: row.try_get("form_payload")?,
                            })
                        })
                        .collect::<Result<Vec<_>, PgWorkflowRuntimeError>>()?;
                    items.shrink_to_fit();
                    Ok((items, has_more))
                })
            },
        )
        .await
        .map_err(KernelError::from)
    }
}

impl WaitingTaskListItem {
    pub fn inbox_position(&self) -> (Option<OffsetDateTime>, OffsetDateTime, String) {
        (
            self.due_at,
            self.created_at,
            format!("approval:{}", self.task_id),
        )
    }
}

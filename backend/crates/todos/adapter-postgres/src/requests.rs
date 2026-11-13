// SPDX-License-Identifier: LicenseRef-Proprietary
//! Requests: one account asks another for a follow-up, stored as a todo the
//! assignee owns. The requester reaches the row only to list and withdraw it,
//! the owner only to finish it or send it back. Every refusal is raised inside
//! the audited transaction, after the row lock, so it writes and audits nothing.

use console_kernel_core::{KernelError, TodoId};
use console_platform_db::{with_audit, with_org_conn};
use console_platform_request_context::current_org;
use console_todos_application::{
    CreateTodoRequestCommand, ListTodoRequestsQuery, ReturnTodoCommand, TodoPage, TodoSummary,
    WithdrawTodoRequestCommand, todo_audit_event,
};
use console_todos_domain::{
    RequestState, TodoText, ensure_due, ensure_not_self, request_links, return_note,
};
use serde_json::json;
use sqlx::{Postgres, QueryBuilder, Transaction};
use uuid::Uuid;

use crate::{PgTodoError, PgTodoStore, refs_to_json, summary_from_row};

pub(crate) fn not_found() -> PgTodoError {
    KernelError::not_found("todo not found").into()
}

/// Locks one of `owner`'s todos: whether it is a request, and where it stands.
/// `None` when the id is unknown or not theirs.
pub(crate) async fn lock_owned(
    tx: &mut Transaction<'_, Postgres>,
    todo: Uuid,
    owner: Uuid,
) -> Result<Option<(bool, RequestState)>, PgTodoError> {
    let row: Option<(bool, bool, bool)> = sqlx::query_as(
        "SELECT assigned_by_user_id IS NOT NULL, done, returned_at IS NOT NULL \
         FROM todos WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
    )
    .bind(todo)
    .bind(owner)
    .fetch_optional(tx.as_mut())
    .await?;
    Ok(row.map(|(request, done, returned)| (request, RequestState::of(done, returned))))
}

fn assignee_refused(message: &str, code: &'static str) -> PgTodoError {
    KernelError::validation(message)
        .with_code(code)
        .with_field("assignee_account_id")
        .into()
}

impl PgTodoStore {
    /// Ask a colleague for a follow-up (audited as `todo.request`, naming only
    /// whom and by when). The assignee is an active account of this tenant
    /// placed under a node where Cedar permits the requester's `todo_assign`,
    /// decided in this transaction and held `FOR SHARE`, so neither a revoked
    /// grant nor a concurrent deactivation slips between check and insert.
    pub async fn create_request(
        &self,
        command: CreateTodoRequestCommand,
    ) -> Result<TodoSummary, PgTodoError> {
        let text = TodoText::new(command.text)?.into_string();
        let links = refs_to_json(&request_links(command.links)?)?;
        ensure_not_self(command.requester, command.assignee)?;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let todo_id = TodoId::new();
        let (requester, assignee) = (*command.requester.as_uuid(), *command.assignee.as_uuid());
        let due_on = command.due_on;
        let today = command
            .occurred_at
            .to_offset(time::macros::offset!(+9))
            .date();
        let asker = command.requester;
        let after =
            json!({ "assignee_user_id": assignee, "due_on": due_on.map(|d| d.to_string()) });
        let event = todo_audit_event(
            "todo.request",
            command.requester,
            todo_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(None, Some(after));

        with_audit::<_, TodoSummary, PgTodoError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let vis = crate::assignees::reach(tx, org, asker).await?;
                let mut q = QueryBuilder::new("SELECT u.is_active FROM users u");
                crate::assignees::push_reach(&mut q, org_uuid, &vis);
                q.push(" AND u.id = ");
                q.push_bind(assignee);
                q.push(" FOR SHARE OF u");
                let active: Option<bool> =
                    q.build_query_scalar().fetch_optional(tx.as_mut()).await?;
                match active {
                    None => {
                        return Err(assignee_refused(
                            "the assignee is not someone you can ask",
                            "todo_assignee_out_of_scope",
                        ));
                    }
                    Some(false) => {
                        return Err(assignee_refused(
                            "the assignee's account is inactive",
                            "todo_assignee_inactive",
                        ));
                    }
                    Some(true) => {}
                }
                ensure_due(due_on, today)?;
                let row = sqlx::query(concat!(
                    "INSERT INTO todos (id, org_id, owner_user_id, assigned_by_user_id, body, \
                     links, due_on) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ",
                    columns!()
                ))
                .bind(todo_id.as_uuid())
                .bind(org_uuid)
                .bind(assignee)
                .bind(requester)
                .bind(text)
                .bind(links)
                .bind(due_on)
                .fetch_one(tx.as_mut())
                .await?;
                summary_from_row(&row)
            })
        })
        .await
    }

    /// What the caller asked of others in one state, newest first.
    pub async fn list_requests(
        &self,
        query: ListTodoRequestsQuery,
    ) -> Result<TodoPage, PgTodoError> {
        let limit = query.limit.clamp(1, 200);
        let requester = *query.requester.as_uuid();
        let done = query.state == RequestState::Done;
        let returned = query.state == RequestState::Returned;
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgTodoError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM todos WHERE assigned_by_user_id = $1 AND done = $2 \
                     AND (returned_at IS NOT NULL) = $3 \
                     ORDER BY created_at DESC, id DESC LIMIT $4"
                ))
                .bind(requester)
                .bind(done)
                .bind(returned)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        let items = rows
            .iter()
            .map(summary_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TodoPage { items })
    }

    /// The requester takes back an open request: the row is deleted (audited as
    /// `todo.withdraw`, which the request row already names). Saved command
    /// outcomes of earlier calls that returned it, the ask among them, keep
    /// their copy under that store's retention.
    pub async fn withdraw_request(
        &self,
        command: WithdrawTodoRequestCommand,
    ) -> Result<(), PgTodoError> {
        let org = current_org().map_err(KernelError::from)?;
        let todo = *command.todo_id.as_uuid();
        let requester = *command.requester.as_uuid();
        let event = todo_audit_event(
            "todo.withdraw",
            command.requester,
            command.todo_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);
        with_audit::<_, (), PgTodoError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let row: Option<(bool, bool)> = sqlx::query_as(
                    "SELECT done, returned_at IS NOT NULL FROM todos \
                     WHERE id = $1 AND assigned_by_user_id = $2 FOR UPDATE",
                )
                .bind(todo)
                .bind(requester)
                .fetch_optional(tx.as_mut())
                .await?;
                let (done, returned) = row.ok_or_else(not_found)?;
                RequestState::of(done, returned).ensure_open()?;
                sqlx::query("DELETE FROM todos WHERE id = $1")
                    .bind(todo)
                    .execute(tx.as_mut())
                    .await?;
                Ok(())
            })
        })
        .await
    }

    /// The owner sends an open request back with a line (audited as
    /// `todo.return`, without the line). A private todo is not found here.
    pub async fn return_request(&self, command: ReturnTodoCommand) -> Result<(), PgTodoError> {
        let note = return_note(command.note)?;
        let org = current_org().map_err(KernelError::from)?;
        let todo = *command.todo_id.as_uuid();
        let owner = *command.owner.as_uuid();
        let occurred_at = command.occurred_at;
        let event = todo_audit_event(
            "todo.return",
            command.owner,
            command.todo_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);
        with_audit::<_, (), PgTodoError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                match lock_owned(tx, todo, owner).await? {
                    Some((true, state)) => state.ensure_open()?,
                    _ => return Err(not_found()),
                }
                sqlx::query(
                    "UPDATE todos SET returned_at = $2, return_note = $3, updated_at = $2 \
                     WHERE id = $1",
                )
                .bind(todo)
                .bind(occurred_at)
                .bind(note)
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await
    }
}

//! Postgres todos adapter.
//!
//! Owner scoping is enforced here in code (there is no per-person GUC): the
//! caller passes the authenticated principal's `UserId`, and every query
//! filters `owner_user_id`, or `assigned_by_user_id` on the requester's own
//! request routes. RLS narrows to the tenant on top of that. A cross-user read
//! or mutation therefore returns *nothing* (or NotFound), never another user's
//! row.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use console_kernel_core::{ErrorKind, KernelError, Timestamp, TodoId, UserId};
use console_platform_db::{DbError, with_audit, with_org_conn};
use console_platform_request_context::current_org;
use console_todos_application::{
    CreateTodoCommand, DeleteTodoCommand, ListTodosQuery, SetTodoDoneCommand, TodoPage,
    TodoSummary, todo_audit_event,
};
use console_todos_domain::{TodoRef, TodoText, validated_refs};
use sqlx::{PgPool, Row};

/// Every column a [`TodoSummary`] reads.
macro_rules! columns {
    () => {
        "id, owner_user_id, body, scopes, links, done, created_at, updated_at, done_at, \
         assigned_by_user_id, due_on, returned_at, return_note"
    };
}

mod requests;
use requests::{lock_owned, not_found};

#[derive(Debug, thiserror::Error)]
pub enum PgTodoError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgTodoError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(error) => error.kind(),
        }
    }
}

impl From<sqlx::Error> for PgTodoError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::from(value))
    }
}

impl From<PgTodoError> for KernelError {
    fn from(value: PgTodoError) -> Self {
        match value {
            PgTodoError::Domain(err) => err,
            PgTodoError::Db(err) => KernelError::internal(err.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PgTodoStore {
    pool: PgPool,
}

/// Owner-authorized, request-ceiling-bounded todo page used by read
/// compositions such as the console workbench. This is deliberately an
/// adapter-owned projection rather than a second todo store or policy layer.
#[derive(Debug, Clone)]
pub struct TodoSnapshotPage {
    pub items: Vec<TodoSummary>,
    pub total: usize,
    pub as_of: Timestamp,
}

impl PgTodoStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Create an owner-scoped todo. Validates the domain invariants and
    /// inserts one row (audited as `todo.create`).
    pub async fn create(&self, command: CreateTodoCommand) -> Result<TodoSummary, PgTodoError> {
        let text = TodoText::new(command.text)?;
        let scopes = validated_refs(command.scopes, "scopes")?;
        let links = validated_refs(command.links, "links")?;
        let scopes_json = refs_to_json(&scopes)?;
        let links_json = refs_to_json(&links)?;

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let todo_id = TodoId::new();
        let owner_uuid = *command.owner.as_uuid();

        let event = todo_audit_event(
            "todo.create",
            command.owner,
            todo_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        let text = text.into_string();
        with_audit::<_, TodoSummary, PgTodoError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(concat!(
                    "INSERT INTO todos (id, org_id, owner_user_id, body, scopes, links) \
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ",
                    columns!()
                ))
                .bind(todo_id.as_uuid())
                .bind(org_uuid)
                .bind(owner_uuid)
                .bind(text)
                .bind(scopes_json)
                .bind(links_json)
                .fetch_one(tx.as_mut())
                .await?;
                summary_from_row(&row)
            })
        })
        .await
    }

    /// List the caller's own todos, open-first then newest-first. Requests are
    /// left out: they arrive in the work inbox, and a returned one is not done.
    pub async fn list(&self, query: ListTodosQuery) -> Result<TodoPage, PgTodoError> {
        let limit = query.limit.clamp(1, 200);
        let owner_uuid = *query.owner.as_uuid();
        let org = current_org().map_err(KernelError::from)?;

        let rows = with_org_conn::<_, _, PgTodoError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    " FROM todos \
                     WHERE owner_user_id = $1 AND assigned_by_user_id IS NULL \
                       AND (done = false OR $2) \
                     ORDER BY done ASC, created_at DESC, id DESC LIMIT $3"
                ))
                .bind(owner_uuid)
                .bind(query.include_done)
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

    /// List the authenticated owner's todos at or before one aggregate request
    /// ceiling. Rows updated after the ceiling are omitted because the current
    /// table is not temporal and cannot truthfully reconstruct their older
    /// version. The window count is evaluated under the same owner predicate,
    /// tenant RLS transaction, and ceiling as the returned page.
    pub async fn list_snapshot(
        &self,
        owner: UserId,
        include_done: bool,
        limit: i64,
        as_of: Timestamp,
    ) -> Result<TodoSnapshotPage, PgTodoError> {
        let limit = limit.clamp(1, 200);
        let owner_uuid = *owner.as_uuid();
        let org = current_org().map_err(KernelError::from)?;

        let rows = with_org_conn::<_, _, PgTodoError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(concat!(
                    "SELECT ",
                    columns!(),
                    ", COUNT(*) OVER() AS snapshot_total FROM todos \
                     WHERE owner_user_id = $1 AND assigned_by_user_id IS NULL \
                       AND (done = false OR $2) AND created_at <= $3 AND updated_at <= $3 \
                     ORDER BY done ASC, created_at DESC, id DESC LIMIT $4"
                ))
                .bind(owner_uuid)
                .bind(include_done)
                .bind(as_of)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;

        let total = rows
            .first()
            .map(|row| row.try_get::<i64, _>("snapshot_total"))
            .transpose()?
            .unwrap_or(0);
        let total = usize::try_from(total).map_err(|_| {
            KernelError::internal("todo snapshot count exceeded the supported range")
        })?;
        let items = rows
            .iter()
            .map(summary_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TodoSnapshotPage {
            items,
            total,
            as_of,
        })
    }

    /// Set one of the caller's todos done/undone (audited as `todo.done` /
    /// `todo.undone`). Returns NotFound when the id is unknown *or* owned by
    /// another user — indistinguishable to the caller, which is the cross-user
    /// isolation guarantee. A request only moves forward: undoing a done one,
    /// or finishing a returned one, is `todo_closed`.
    pub async fn set_done(&self, command: SetTodoDoneCommand) -> Result<TodoSummary, PgTodoError> {
        let org = current_org().map_err(KernelError::from)?;
        let owner_uuid = *command.owner.as_uuid();
        let todo_uuid = *command.todo_id.as_uuid();
        let done = command.done;
        let occurred_at = command.occurred_at;
        let event = todo_audit_event(
            if done { "todo.done" } else { "todo.undone" },
            command.owner,
            command.todo_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, TodoSummary, PgTodoError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                match lock_owned(tx, todo_uuid, owner_uuid).await? {
                    None => return Err(not_found()),
                    Some((true, state)) => state.ensure_done_allowed(done)?,
                    Some((false, _)) => {}
                }
                let row = sqlx::query(concat!(
                    "UPDATE todos SET done = $3, \
                     done_at = CASE WHEN $3 THEN COALESCE(done_at, $4) ELSE NULL END, \
                     updated_at = $4 WHERE id = $1 AND owner_user_id = $2 RETURNING ",
                    columns!()
                ))
                .bind(todo_uuid)
                .bind(owner_uuid)
                .bind(done)
                .bind(occurred_at)
                .fetch_one(tx.as_mut())
                .await?;
                summary_from_row(&row)
            })
        })
        .await
    }

    /// Delete one of the caller's todos (audited as `todo.delete`). NotFound
    /// for an unknown or cross-user id, same as [`Self::set_done`]. A request is
    /// `todo_is_request`: only its requester takes it back, by withdrawing.
    pub async fn delete(&self, command: DeleteTodoCommand) -> Result<(), PgTodoError> {
        let org = current_org().map_err(KernelError::from)?;
        let owner_uuid = *command.owner.as_uuid();
        let todo_uuid = *command.todo_id.as_uuid();
        let event = todo_audit_event(
            "todo.delete",
            command.owner,
            command.todo_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, (), PgTodoError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                match lock_owned(tx, todo_uuid, owner_uuid).await? {
                    None => return Err(not_found()),
                    Some((true, _)) => {
                        return Err(KernelError::conflict(
                            "a request is not deleted by its owner; finish it or send it back",
                        )
                        .with_code("todo_is_request")
                        .into());
                    }
                    Some((false, _)) => {}
                }
                sqlx::query("DELETE FROM todos WHERE id = $1")
                    .bind(todo_uuid)
                    .execute(tx.as_mut())
                    .await?;
                Ok(())
            })
        })
        .await
    }
}

fn refs_to_json(refs: &[TodoRef]) -> Result<serde_json::Value, PgTodoError> {
    serde_json::to_value(refs)
        .map_err(|err| KernelError::internal(format!("todo refs are not JSON: {err}")).into())
}

fn refs_from_json(value: serde_json::Value, column: &str) -> Result<Vec<TodoRef>, PgTodoError> {
    serde_json::from_value(value)
        .map_err(|err| KernelError::internal(format!("stored todo {column} invalid: {err}")).into())
}

fn summary_from_row(row: &sqlx::postgres::PgRow) -> Result<TodoSummary, PgTodoError> {
    Ok(TodoSummary {
        id: TodoId::from_uuid(row.try_get("id")?),
        owner_user_id: UserId::from_uuid(row.try_get("owner_user_id")?),
        text: row.try_get("body")?,
        scopes: refs_from_json(row.try_get("scopes")?, "scopes")?,
        links: refs_from_json(row.try_get("links")?, "links")?,
        done: row.try_get("done")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        done_at: row.try_get("done_at")?,
        assigned_by_user_id: row
            .try_get::<Option<uuid::Uuid>, _>("assigned_by_user_id")?
            .map(UserId::from_uuid),
        due_on: row.try_get("due_on")?,
        returned_at: row.try_get("returned_at")?,
        return_note: row.try_get("return_note")?,
    })
}

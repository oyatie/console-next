//! Todos application contracts.
//!
//! Owner-scoped CRUD shapes the Postgres adapter implements. Every command
//! carries the caller bound from the authenticated principal — never from
//! request input — mirroring the notifications recipient-scoping idiom. The one
//! account named by input is a request's assignee, checked by Cedar against the
//! requester's to-do request grants.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use console_kernel_core::{
    AuditAction, AuditEvent, KernelError, Timestamp, TodoId, TraceContext, UserId,
};
use console_todos_domain::{RequestLink, RequestState, TodoRef};
use serde::{Deserialize, Serialize};
use time::Date;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateTodoCommand {
    /// Bound from the authenticated principal, never from request input.
    pub owner: UserId,
    pub text: String,
    /// Scope chips: person/team/site/entity refs.
    pub scopes: Vec<TodoRef>,
    /// Object links: kind+id pairs into the object registry.
    pub links: Vec<TodoRef>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetTodoDoneCommand {
    pub owner: UserId,
    pub todo_id: TodoId,
    /// Explicit target state so the same endpoint supports done AND undo.
    pub done: bool,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteTodoCommand {
    pub owner: UserId,
    pub todo_id: TodoId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListTodosQuery {
    pub owner: UserId,
    /// `false` = open items only (the Today/Plan panel default).
    pub include_done: bool,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoSummary {
    pub id: TodoId,
    pub owner_user_id: UserId,
    pub text: String,
    pub scopes: Vec<TodoRef>,
    pub links: Vec<TodoRef>,
    pub done: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
    #[serde(with = "time::serde::rfc3339::option")]
    pub done_at: Option<Timestamp>,
    /// The account that asked for this todo. Absent on the owner's own todo,
    /// as are the three request fields below, so a private todo reads as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_by_user_id: Option<UserId>,
    #[serde(
        default,
        with = "iso_date::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub due_on: Option<Date>,
    #[serde(
        default,
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub returned_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_note: Option<String>,
}

/// Ask a colleague for a follow-up: a todo owned by `assignee`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateTodoRequestCommand {
    /// Bound from the authenticated principal, never from request input.
    pub requester: UserId,
    pub assignee: UserId,
    pub text: String,
    pub due_on: Option<Date>,
    pub links: Vec<RequestLink>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// What the caller asked of others, in one state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListTodoRequestsQuery {
    pub requester: UserId,
    pub state: RequestState,
    pub limit: i64,
}

/// The requester takes back an open request; the row is deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawTodoRequestCommand {
    pub requester: UserId,
    pub todo_id: TodoId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// The owner sends an open request back with a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReturnTodoCommand {
    pub owner: UserId,
    pub todo_id: TodoId,
    pub note: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoPage {
    pub items: Vec<TodoSummary>,
}

/// The active accounts, other than the requester, it may ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListTodoAssigneesQuery {
    pub requester: UserId,
    /// Matched case-insensitively anywhere in the display name.
    pub search: Option<String>,
    pub limit: i64,
}

/// An account a requester may ask, by name only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoAssignee {
    pub account_id: UserId,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoAssigneePage {
    pub items: Vec<TodoAssignee>,
}

/// Build the audit event for an owner self-action on a todo.
pub fn todo_audit_event(
    action: &str,
    actor: UserId,
    todo_id: TodoId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "todo",
        todo_id.to_string(),
        trace,
        occurred_at,
    ))
}

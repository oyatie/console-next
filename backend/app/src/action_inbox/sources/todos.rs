// SPDX-License-Identifier: LicenseRef-Proprietary
//! To-do requests: the assignee's open request (their turn) and the
//! requester's open or returned one (what they wait on), each shown to that
//! account alone. A to-do item is not a read of an employee record: its links
//! carry ids only, so nothing goes to the personnel access log.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSource, ActionInboxSourceItem, ActionInboxSourcePage,
    ActionInboxSourceQuery,
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_todos_adapter_postgres::{InboxRole, PgTodoStore};
use serde_json::json;
use time::macros::offset;

pub(crate) async fn page(
    pool: &sqlx::PgPool,
    principal: &Principal,
    source: ActionInboxSource,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    // A support session asks nobody and is asked nothing.
    if principal.support.is_some() {
        return Ok(super::super::empty_source_page());
    }
    let (role, kind) = if source == ActionInboxSource::TodoRequested {
        (InboxRole::Requested, "todo_requested")
    } else {
        (InboxRole::Assigned, "todo_assigned")
    };
    let page = PgTodoStore::new(pool.clone())
        .inbox_page(
            principal.org_id,
            principal.user_id,
            role,
            query.as_of,
            query.after.map(|at| (at.due, at.created_at, at.id)),
            i64::try_from(query.limit).unwrap_or(200),
        )
        .await
        .map_err(|error| {
            tracing::error!(source = kind, error = %error, "action-inbox source read failed");
            KernelError::internal("failed to load action inbox")
        })?;
    let items = page
        .items
        .into_iter()
        .map(|row| {
            let todo = row.todo;
            let id = todo.id.to_string();
            // The requester's item wakes from a snooze when the request is sent back.
            let context = (role == InboxRole::Requested).then(|| {
                let state = if todo.returned_at.is_some() {
                    "returned"
                } else {
                    "open"
                };
                let mut facts = json!({ "state": state });
                if let Some(note) = &todo.return_note {
                    facts["return_note"] = json!(note);
                }
                json!({ "todo": facts, "decision": { "version": state } })
            });
            let links = std::iter::once(ActionInboxLink {
                kind: "todo".to_owned(),
                id: id.clone(),
                label: None,
            })
            .chain(todo.links.into_iter().map(|link| ActionInboxLink {
                kind: link.kind,
                id: link.id,
                label: None,
            }))
            .collect();
            ActionInboxSourceItem {
                context,
                due_basis: None,
                id: format!("{}{id}", role.id_prefix()),
                kind: kind.to_owned(),
                ref_code: String::new(),
                title: todo.text,
                site: None,
                who: row.other_name,
                due: row.due.map(|due| due.to_offset(offset!(+9))),
                submitted: Some(todo.created_at.to_offset(offset!(+9))),
                links,
                created_at: todo.created_at.to_offset(offset!(+9)),
            }
        })
        .collect();
    Ok(ActionInboxSourcePage {
        items,
        total: usize::try_from(page.total).unwrap_or(0),
        total_is_exact: true,
        has_more: page.has_more,
    })
}

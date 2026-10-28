// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    ActionInboxPage, ActionInboxSourcePort, CompleteActionInboxError, ListActionInboxQuery,
    MAX_COMPLETE_ITEMS, MAX_COMPLETE_PAGES, MAX_PAGE_LIMIT, list_action_inbox,
};
use std::collections::HashSet;
use time::OffsetDateTime;
/// Traverses the public snapshot cursor API until the action set is complete.
///
/// This is intentionally separate from `list_action_inbox`: the public endpoint
/// uses bounded deadline pages, while consumers that apply a different
/// deterministic ordering (such as Workbench urgency) must not rank only its
/// first partial page. Every response must advertise the same exact
/// total, and the traversal stops fail-closed at `MAX_COMPLETE_ITEMS`.
pub async fn list_complete_action_inbox(
    port: &dyn ActionInboxSourcePort,
    now: OffsetDateTime,
) -> Result<ActionInboxPage, CompleteActionInboxError> {
    let exact = ExactPort { port };
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut expected_total = None;
    let mut items = Vec::new();
    let mut page_count = 0;

    loop {
        if page_count == MAX_COMPLETE_PAGES {
            return Err(CompleteActionInboxError::BudgetExceeded);
        }
        page_count += 1;
        let request_cursor = cursor.take();
        let page = list_action_inbox(
            &exact,
            ListActionInboxQuery {
                limit: Some(MAX_PAGE_LIMIT),
                cursor: request_cursor.clone(),
            },
            now,
        )
        .await
        .map_err(CompleteActionInboxError::Source)?;
        if !page.total_is_exact {
            return Err(CompleteActionInboxError::TotalInexact);
        }
        match expected_total {
            Some(total) if total != page.total => {
                return Err(CompleteActionInboxError::TotalDrift);
            }
            Some(_) => {}
            None if page.total > MAX_COMPLETE_ITEMS => {
                return Err(CompleteActionInboxError::BudgetExceeded);
            }
            None => expected_total = Some(page.total),
        }
        for item in page.items {
            if !seen_ids.insert(item.id.clone()) {
                return Err(CompleteActionInboxError::DuplicateId);
            }
            items.push(item);
            if items.len() > MAX_COMPLETE_ITEMS {
                return Err(CompleteActionInboxError::BudgetExceeded);
            }
        }
        match page.next_cursor {
            Some(next) => {
                ensure_new_cursor(request_cursor.as_deref(), &mut seen_cursors, &next)?;
                cursor = Some(next);
            }
            None => {
                let total = expected_total.ok_or(CompleteActionInboxError::TotalDrift)?;
                if items.len() != total {
                    return Err(CompleteActionInboxError::TotalDrift);
                }
                return Ok(ActionInboxPage {
                    unavailable: Vec::new(),
                    counts: crate::filter::counts(&items, true),
                    upcoming: Vec::new(),
                    items,
                    total,
                    total_is_exact: true,
                    next_cursor: None,
                });
            }
        }
    }
}

pub(crate) fn ensure_new_cursor(
    request_cursor: Option<&str>,
    seen_cursors: &mut HashSet<String>,
    next_cursor: &str,
) -> Result<(), CompleteActionInboxError> {
    if request_cursor == Some(next_cursor) || !seen_cursors.insert(next_cursor.to_owned()) {
        return Err(CompleteActionInboxError::RepeatedCursor);
    }
    Ok(())
}

struct ExactPort<'a> {
    port: &'a dyn ActionInboxSourcePort,
}
impl ActionInboxSourcePort for ExactPort<'_> {
    fn deadline_due_soon_days(&self) -> Result<i64, console_kernel_core::KernelError> {
        self.port.deadline_due_soon_days()
    }
    fn list_source_page(
        &self,
        source: crate::ActionInboxSource,
        mut query: crate::ActionInboxSourceQuery,
    ) -> crate::ActionInboxSourceFuture<'_> {
        query.require_exact_total = true;
        self.port.list_source_page(source, query)
    }
}

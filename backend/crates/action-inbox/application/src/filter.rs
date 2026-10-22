// SPDX-License-Identifier: LicenseRef-Proprietary
//! Server-side saved views over the same immutable traversal as the unfiltered queue.
use console_kernel_core::KernelError;
use serde::Deserialize;
use time::OffsetDateTime;

use crate::{
    ActionInboxItem, ActionInboxPage, ActionInboxPosition, ActionInboxSourcePort,
    ListActionInboxQuery, MAX_PAGE_LIMIT, encode_cursor, list_action_inbox, parse_cursor,
};

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InboxFilter {
    #[default]
    All,
    Turn,
    Waiting,
    Scheduled,
    Deadlines,
    Failures,
}

impl InboxFilter {
    fn includes(self, item: &ActionInboxItem) -> bool {
        match self {
            Self::All => true,
            Self::Turn => item.lane == "turn",
            Self::Waiting => item.lane == "waiting",
            Self::Scheduled => item.lane == "scheduled",
            Self::Deadlines => item.lane == "turn" && matches!(item.due_tone, "danger" | "warn"),
            Self::Failures => item.kind == "lifecycle_apply_failed",
        }
    }
}

/// A view may scan past non-matching rows, but its continuation always names
/// the last returned row. Resolved rows disappear and new inserts stay beyond
/// the admission instant. Inexact counts explicitly describe a prefix only.
pub async fn list_filtered_action_inbox(
    port: &dyn ActionInboxSourcePort,
    query: ListActionInboxQuery,
    filter: InboxFilter,
    now: OffsetDateTime,
) -> Result<ActionInboxPage, KernelError> {
    if filter == InboxFilter::All {
        return list_action_inbox(port, query, now).await;
    }
    let limit = query
        .limit
        .unwrap_or(crate::DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let first = query.cursor.is_none();
    let mut cursor = query.cursor;
    let as_of = cursor
        .as_deref()
        .map(|c| parse_cursor(c, now))
        .transpose()?
        .map_or(now, |c| c.as_of);
    let view = ViewPort { port, filter };
    let mut exact = true;
    let mut items = Vec::new();
    loop {
        let page = list_action_inbox(
            &view,
            ListActionInboxQuery {
                limit: Some(MAX_PAGE_LIMIT),
                cursor: cursor.clone(),
            },
            now,
        )
        .await?;
        exact &= page.total_is_exact;
        items.extend(page.items.into_iter().filter(|item| filter.includes(item)));
        if items.len() > limit {
            items.truncate(limit);
            let last = items
                .last()
                .ok_or_else(|| KernelError::internal("empty inbox continuation"))?;
            let next_cursor = Some(encode_cursor(
                as_of,
                &ActionInboxPosition {
                    created_at: last.created_at,
                    id: last.id.clone(),
                },
            ));
            return Ok(ActionInboxPage {
                total: items.len(),
                total_is_exact: false,
                items,
                next_cursor,
            });
        }
        match page.next_cursor {
            Some(next) if cursor.as_ref() != Some(&next) => cursor = Some(next),
            Some(_) => return Err(KernelError::internal("inbox source repeated its cursor")),
            None => {
                return Ok(ActionInboxPage {
                    total: items.len(),
                    total_is_exact: first && exact,
                    items,
                    next_cursor: None,
                });
            }
        }
    }
}

struct ViewPort<'a> {
    port: &'a dyn ActionInboxSourcePort,
    filter: InboxFilter,
}
impl ActionInboxSourcePort for ViewPort<'_> {
    fn list_source_page(
        &self,
        source: crate::ActionInboxSource,
        mut query: crate::ActionInboxSourceQuery,
    ) -> crate::ActionInboxSourceFuture<'_> {
        use crate::ActionInboxSource as S;
        let included = match self.filter {
            InboxFilter::Waiting | InboxFilter::Scheduled => source == S::OrgChange,
            InboxFilter::Failures => source == S::HrLifecycle,
            InboxFilter::Deadlines => !matches!(
                source,
                S::HrIdentity
                    | S::HrBranch
                    | S::HrRegister
                    | S::HrRequests
                    | S::HrLifecycle
                    | S::Setup
                    | S::GrantNotice
                    | S::Payroll
                    | S::Governance
            ),
            _ => true,
        };
        if included {
            query.filter = self.filter;
            self.port.list_source_page(source, query)
        } else {
            Box::pin(async {
                Ok(crate::ActionInboxSourcePage {
                    items: Vec::new(),
                    total: 0,
                    total_is_exact: true,
                    has_more: false,
                })
            })
        }
    }
}

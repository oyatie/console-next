// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A lane count is a lower bound only when a source that can fill that lane
//! left rows unread: the requester's many asks never make the turn count
//! inexact, and the assignee's never make the waiting count inexact.
use console_action_inbox_application::*;
use time::{Duration, OffsetDateTime};

/// `assigned` requests owed by the caller and `requested` ones they wait on.
struct Asks {
    assigned: usize,
    requested: usize,
}

impl ActionInboxSourcePort for Asks {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        let (kind, count) = match source {
            ActionInboxSource::TodoAssigned => ("todo_assigned", self.assigned),
            ActionInboxSource::TodoRequested => ("todo_requested", self.requested),
            _ => ("", 0),
        };
        let items: Vec<_> = (0..count)
            .map(|n| ActionInboxSourceItem {
                due_basis: None,
                context: None,
                id: format!("{kind}:{}", uuid::Uuid::from_u128(n as u128 + 1)),
                kind: kind.into(),
                ref_code: String::new(),
                title: String::new(),
                site: None,
                who: None,
                due: None,
                submitted: None,
                links: vec![],
                created_at: query.now - Duration::days(n as i64 + 1),
            })
            .collect();
        let total = items.len();
        let (items, has_more) = page_source_items(items, &query);
        Box::pin(async move {
            Ok(ActionInboxSourcePage {
                items,
                total,
                total_is_exact: true,
                has_more,
            })
        })
    }
}

fn read(asks: &Asks, filter: InboxFilter, limit: usize) -> ActionInboxPage {
    let mut future = std::pin::pin!(list_filtered_action_inbox(
        asks,
        ListActionInboxQuery {
            limit: Some(limit),
            cursor: None
        },
        filter,
        OffsetDateTime::UNIX_EPOCH + Duration::days(30)
    ));
    let std::task::Poll::Ready(result) = future
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
    else {
        panic!("ready source")
    };
    result.unwrap()
}

fn exact(page: &ActionInboxPage) -> [(&'static str, bool); 3] {
    ["turn", "deadlines", "waiting"].map(|lane| (lane, page.counts[lane].total_is_exact))
}

#[test]
fn the_requesters_unread_asks_leave_the_turn_count_exact() {
    let asks = Asks {
        assigned: 1,
        requested: 7,
    };
    // The turn view's first round reads one row past its limit: six of seven asks.
    for (filter, limit) in [(InboxFilter::All, 6), (InboxFilter::Turn, 5)] {
        let page = read(&asks, filter, limit);
        assert_eq!(
            exact(&page),
            [("turn", true), ("deadlines", true), ("waiting", false)],
            "{filter:?}"
        );
        assert_eq!(page.counts["turn"].total, 1, "{filter:?}");
    }
    // The whole inbox counts from each source's own total, past the page it read.
    let all = &read(&asks, InboxFilter::Turn, 5).attention_filters[0];
    assert_eq!((all.total, all.total_is_exact), (8, true));
}

#[test]
fn the_assignees_unread_asks_leave_the_waiting_count_exact() {
    let page = read(
        &Asks {
            assigned: 7,
            requested: 1,
        },
        InboxFilter::All,
        6,
    );
    assert_eq!(
        exact(&page),
        [("turn", false), ("deadlines", false), ("waiting", true)]
    );
    assert_eq!(page.counts["waiting"].total, 1);
}

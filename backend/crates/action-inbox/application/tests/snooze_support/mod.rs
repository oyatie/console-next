// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A paging fake source and the calls the snooze tests share.
pub use console_action_inbox_application::{ActionInboxSource as S, *};
use std::sync::Mutex;
use time::macros::{date, datetime};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

/// Thursday noon in Korea.
pub const NOW: OffsetDateTime = datetime!(2026-11-12 03:00 UTC);
pub const TODAY: Date = date!(2026 - 11 - 12);
pub const LATER: Date = date!(2026 - 11 - 19);

#[derive(Default)]
pub struct Source {
    pub items: Vec<(S, ActionInboxSourceItem)>,
    pub asked: Mutex<Vec<S>>,
}

impl Source {
    pub fn of(items: impl IntoIterator<Item = (S, ActionInboxSourceItem)>) -> Self {
        Self {
            items: items.into_iter().collect(),
            asked: Mutex::default(),
        }
    }
}

impl ActionInboxSourcePort for Source {
    fn list_source_page(
        &self,
        source: S,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        self.asked.lock().unwrap().push(source);
        let all: Vec<_> = self
            .items
            .iter()
            .filter(|(from, item)| *from == source && item.created_at <= query.as_of)
            .map(|(_, item)| item.clone())
            .collect();
        let total = all.len();
        let (items, has_more) = page_source_items(all, &query);
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

pub fn id(namespace: &str, n: u128) -> String {
    format!("{namespace}:{}", Uuid::from_u128(n))
}

/// Items of one namespace list in the order of `n`.
pub fn item(namespace: &str, n: u128) -> ActionInboxSourceItem {
    ActionInboxSourceItem {
        context: None,
        due_basis: None,
        id: id(namespace, n),
        kind: namespace.to_owned(),
        ref_code: String::new(),
        title: format!("Item {n}"),
        site: None,
        who: None,
        due: None,
        submitted: None,
        links: Vec::new(),
        created_at: NOW - Duration::DAY + Duration::seconds(n as i64),
    }
}

pub fn work(
    range: std::ops::RangeInclusive<u128>,
) -> impl Iterator<Item = (S, ActionInboxSourceItem)> {
    range.map(|n| (S::WorkOrder, item("work", n)))
}

pub fn until(date: Date) -> Snooze {
    Snooze {
        until: date,
        item_version: None,
        created_at: NOW - Duration::hours(2),
    }
}

pub fn snoozed(ids: &[String], mode: SnoozeMode) -> Snoozes {
    Snoozes::new(ids.iter().map(|id| (id.clone(), until(LATER))), mode, NOW)
}

pub fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("fake source must be ready"),
    }
}

pub fn list(
    source: &Source,
    snoozes: &Snoozes,
    limit: usize,
    cursor: Option<String>,
) -> ActionInboxPage {
    let port = SnoozedPort {
        port: source,
        snoozes,
    };
    let query = ListActionInboxQuery {
        limit: Some(limit),
        cursor,
    };
    let mut page = block_on(list_action_inbox(&port, query, NOW)).unwrap();
    snoozes.annotate(&mut page);
    page
}

pub fn ids(page: &ActionInboxPage) -> Vec<String> {
    page.items.iter().map(|item| item.id.clone()).collect()
}

pub fn count(total: usize, total_is_exact: bool) -> InboxCount {
    InboxCount {
        total,
        total_is_exact,
    }
}

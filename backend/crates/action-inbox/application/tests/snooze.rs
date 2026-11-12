// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A postponed item leaves the list, its pages and its totals together.
use console_action_inbox_application::{ActionInboxSource as S, *};
use serde_json::json;
use std::sync::Mutex;
use time::macros::{date, datetime};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

/// Thursday noon in Korea.
const NOW: OffsetDateTime = datetime!(2026-11-12 03:00 UTC);
const TODAY: Date = date!(2026 - 11 - 12);
const LATER: Date = date!(2026 - 11 - 19);

#[derive(Default)]
struct Source {
    items: Vec<(S, ActionInboxSourceItem)>,
    asked: Mutex<Vec<S>>,
}

impl Source {
    fn of(items: impl IntoIterator<Item = (S, ActionInboxSourceItem)>) -> Self {
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

fn id(namespace: &str, n: u128) -> String {
    format!("{namespace}:{}", Uuid::from_u128(n))
}

/// Items of one namespace list in the order of `n`.
fn item(namespace: &str, n: u128) -> ActionInboxSourceItem {
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

fn work(range: std::ops::RangeInclusive<u128>) -> impl Iterator<Item = (S, ActionInboxSourceItem)> {
    range.map(|n| (S::WorkOrder, item("work", n)))
}

fn until(date: Date) -> Snooze {
    Snooze {
        until: date,
        item_version: None,
        created_at: NOW - Duration::hours(2),
    }
}

fn snoozed(ids: &[String], mode: SnoozeMode) -> Snoozes {
    Snoozes::new(ids.iter().map(|id| (id.clone(), until(LATER))), mode, NOW)
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        std::task::Poll::Pending => panic!("fake source must be ready"),
    }
}

fn list(
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

fn ids(page: &ActionInboxPage) -> Vec<String> {
    page.items.iter().map(|item| item.id.clone()).collect()
}

fn count(total: usize, total_is_exact: bool) -> InboxCount {
    InboxCount {
        total,
        total_is_exact,
    }
}

#[test]
fn limit_one_with_the_first_item_snoozed_returns_the_second_and_a_cursor() {
    let source = Source::of(work(1..=3));
    let hidden = [id("work", 1)];
    let snoozes = snoozed(&hidden, SnoozeMode::Exclude);
    let first = list(&source, &snoozes, 1, None);
    assert_eq!(ids(&first), [id("work", 2)]);
    assert_eq!((first.total, first.total_is_exact), (2, true));
    assert_eq!(first.counts["snoozed"], count(1, true));
    let cursor = first.next_cursor.expect("the third item is still to come");

    let second = list(&source, &snoozes, 1, Some(cursor.clone()));
    assert_eq!(ids(&second), [id("work", 3)]);
    assert!(second.next_cursor.is_none());
    assert_eq!(
        (second.total, second.total_is_exact),
        (2, true),
        "a later page of the same request remembers what the first one hid"
    );

    // A new request starts after the cursor and cannot see what was hidden before it.
    let later = list(
        &source,
        &snoozed(&hidden, SnoozeMode::Exclude),
        1,
        Some(cursor),
    );
    assert_eq!(ids(&later), [id("work", 3)]);
    assert_eq!((later.total, later.total_is_exact), (2, false));
}

#[test]
fn a_page_whose_items_are_all_snoozed_still_pages_on() {
    let source = Source::of(work(1..=5));
    let snoozes = snoozed(
        &[id("work", 1), id("work", 2), id("work", 3)],
        SnoozeMode::Exclude,
    );
    let page = list(&source, &snoozes, 2, None);
    assert_eq!(ids(&page), [id("work", 4), id("work", 5)]);
    assert!(page.next_cursor.is_none());
    assert_eq!((page.total, page.total_is_exact), (2, true));
    assert_eq!(page.counts["snoozed"], count(3, true));
}

#[test]
fn totals_stay_exact_when_the_source_is_read_to_its_end() {
    let source = Source::of(work(1..=4));
    // The second row names an item that has since left the inbox.
    let snoozes = snoozed(&[id("work", 2), id("work", 99)], SnoozeMode::Exclude);
    let page = list(&source, &snoozes, 10, None);
    assert_eq!(ids(&page), [id("work", 1), id("work", 3), id("work", 4)]);
    assert_eq!((page.total, page.total_is_exact), (3, true));
    assert_eq!(
        page.attention_filters[0].total, 3,
        "the tab count is the rows shown"
    );
    assert_eq!(page.counts["turn"].total, 3);
    assert_eq!(
        page.counts["snoozed"],
        count(1, true),
        "a snooze whose item is gone is not counted"
    );
}

#[test]
fn a_snooze_not_seen_in_an_unfinished_source_makes_only_that_total_inexact() {
    let source = Source::of(work(1..=5).chain([(S::Workflow, item("approval", 1))]));
    // Seen in its own source: it says nothing about the unfinished one.
    let seen = [id("approval", 1)];
    let page = list(&source, &snoozed(&seen, SnoozeMode::Exclude), 2, None);
    assert_eq!(ids(&page), [id("work", 1), id("work", 2)]);
    assert_eq!((page.total, page.total_is_exact), (5, true));
    assert_eq!(page.counts["snoozed"], count(1, true));

    let beyond = [id("approval", 1), id("work", 5)];
    let page = list(&source, &snoozed(&beyond, SnoozeMode::Exclude), 2, None);
    assert_eq!(ids(&page), [id("work", 1), id("work", 2)]);
    assert_eq!(
        (page.total, page.total_is_exact),
        (4, false),
        "an honest lower bound, not a wrong exact number"
    );
    assert_eq!(page.counts["snoozed"], count(1, false));
}

#[test]
fn the_snoozed_view_lists_only_snoozed_items_with_their_dates() {
    let source = Source::of(work(1..=3).chain([
        (S::Workflow, item("approval", 1)),
        (S::HrRequests, item("hr_request", 1)),
    ]));
    let rows = [id("hr_request", 1), id("work", 2)];
    let snoozes = snoozed(&rows, SnoozeMode::Only);
    let page = list(&source, &snoozes, 10, None);
    assert_eq!(ids(&page), rows);
    assert!(
        page.items
            .iter()
            .all(|item| item.snooze.until == Some(LATER))
    );
    assert_eq!((page.total, page.total_is_exact), (2, true));
    assert_eq!(page.counts["snoozed"], count(2, true));
    let mut asked = source.asked.lock().unwrap().clone();
    asked.dedup();
    assert_eq!(
        asked,
        [S::WorkOrder, S::HrRequests],
        "only a source that holds a snoozed id is read"
    );

    // One row a page: the view pages like the list.
    let first = list(&source, &snoozed(&rows, SnoozeMode::Only), 1, None);
    assert_eq!(ids(&first), [id("hr_request", 1)]);
    let second = list(
        &source,
        &snoozed(&rows, SnoozeMode::Only),
        1,
        first.next_cursor,
    );
    assert_eq!(ids(&second), [id("work", 2)]);
    assert!(second.next_cursor.is_none());
}

#[test]
fn a_snooze_ends_on_its_date_on_a_new_version_and_when_the_item_becomes_overdue() {
    let versioned = |n, version: &str| ActionInboxSourceItem {
        context: Some(json!({"decision": {"version": version}})),
        ..item("work", n)
    };
    let due = |n, due| ActionInboxSourceItem {
        due: Some(due),
        ..item("work", n)
    };
    let source = Source::of(
        [
            item("work", 1),
            versioned(2, "v2"),
            due(3, NOW - Duration::HOUR),
            due(4, NOW - Duration::hours(3)),
            versioned(5, "v1"),
        ]
        .map(|item| (S::WorkOrder, item)),
    );
    let seen_as = |version: &str| Snooze {
        item_version: Some(version.to_owned()),
        ..until(LATER)
    };
    let snoozes = Snoozes::new(
        [
            (id("work", 1), until(TODAY)),
            (id("work", 2), seen_as("v1")),
            // Snoozed two hours ago; the deadline passed an hour ago.
            (id("work", 3), until(LATER)),
            // Already overdue when it was snoozed: no new fact.
            (id("work", 4), until(LATER)),
            (id("work", 5), seen_as("v1")),
        ],
        SnoozeMode::Exclude,
        NOW,
    );
    let page = list(&source, &snoozes, 10, None);
    let mut shown = ids(&page);
    shown.sort();
    assert_eq!(shown, [id("work", 1), id("work", 2), id("work", 3)]);
    assert_eq!((page.total, page.total_is_exact), (3, true));
    assert_eq!(page.counts["snoozed"], count(2, true));
}

#[test]
fn the_complete_traversal_keeps_one_exact_total_across_its_pages() {
    for hidden in [
        vec![id("work", 10)],
        vec![id("work", 230)],
        vec![id("work", 10), id("work", 999)],
    ] {
        let source = Source::of(work(1..=250));
        let snoozes = snoozed(&hidden, SnoozeMode::Exclude);
        let port = SnoozedPort {
            port: &source,
            snoozes: &snoozes,
        };
        let page = block_on(list_complete_action_inbox(&port, NOW))
            .unwrap_or_else(|error| panic!("{hidden:?}: {error:?}"));
        assert_eq!((page.total, page.items.len()), (249, 249), "{hidden:?}");
        assert!(!ids(&page).contains(&hidden[0]), "{hidden:?}");
    }
}

#[test]
fn a_read_that_includes_snoozed_items_changes_nothing() {
    let source = Source::of(work(1..=3));
    let page = list(
        &source,
        &snoozed(&[id("work", 2)], SnoozeMode::Include),
        10,
        None,
    );
    assert_eq!(ids(&page).len(), 3);
    assert_eq!(page.total, 3);
}

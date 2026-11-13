// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The snoozed view, and the moments a snooze ends by itself.
mod snooze_support;
use serde_json::json;
use snooze_support::*;
use time::Duration;

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
fn the_snoozed_view_pages_on_when_a_full_page_leaves_a_snoozed_item_unread() {
    let source = Source::of(work(1..=5));
    let rows = [id("work", 1), id("work", 4)];
    let first = list(&source, &snoozed(&rows, SnoozeMode::Only), 1, None);
    assert_eq!(ids(&first), [id("work", 1)]);
    let cursor = first
        .next_cursor
        .expect("the second snoozed item is still to come");
    let second = list(&source, &snoozed(&rows, SnoozeMode::Only), 1, Some(cursor));
    assert_eq!(ids(&second), [id("work", 4)]);
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

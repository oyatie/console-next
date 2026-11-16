// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A postponed item leaves the list, its pages and its totals together.
mod snooze_support;
use snooze_support::*;

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

    // The only snooze lies past what was read: the count is a lower bound of zero, never an exact zero.
    let alone = [id("work", 5)];
    let page = list(&source, &snoozed(&alone, SnoozeMode::Exclude), 2, None);
    assert_eq!(page.counts["snoozed"], count(0, false));
}

/// A source that counts the rows after its cursor, as some sources do.
struct FromCursor(Source);

impl ActionInboxSourcePort for FromCursor {
    fn list_source_page(
        &self,
        source: S,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        let before = query.after.as_ref().map_or(0, |after| {
            let ids: Vec<_> = self
                .0
                .items
                .iter()
                .filter(|(from, _)| *from == source)
                .collect();
            ids.iter()
                .position(|(_, item)| item.id == after.id)
                .map_or(0, |at| at + 1)
        });
        let page = self.0.list_source_page(source, query);
        Box::pin(async move {
            let mut page = page.await?;
            page.total -= before;
            Ok(page)
        })
    }
}

#[test]
fn a_refilled_page_keeps_the_total_of_the_query_it_answers() {
    let source = FromCursor(Source::of(work(1..=6)));
    let snoozes = snoozed(&[id("work", 2)], SnoozeMode::Exclude);
    let port = SnoozedPort {
        port: &source,
        snoozes: &snoozes,
    };
    let query = ListActionInboxQuery {
        limit: Some(3),
        cursor: None,
    };
    let page = block_on(list_action_inbox(&port, query, NOW)).unwrap();
    assert_eq!(ids(&page), [id("work", 1), id("work", 3), id("work", 4)]);
    assert_eq!((page.total, page.total_is_exact), (5, true));
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

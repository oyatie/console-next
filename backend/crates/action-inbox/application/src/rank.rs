// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{ActionInboxCursor, ActionInboxItem, ActionInboxSourceItem, ActionInboxSourceQuery};
use time::OffsetDateTime;

/// Sources that already materialize their authorized set use the same key before limiting it.
pub fn page_source_items(
    mut items: Vec<ActionInboxSourceItem>,
    query: &ActionInboxSourceQuery,
) -> (Vec<ActionInboxSourceItem>, bool) {
    items.retain(|item| {
        item.created_at <= query.as_of
            && query.after.as_ref().is_none_or(|after| {
                compare_key(
                    (item.due, item.created_at, &item.id),
                    (after.due, after.created_at, &after.id),
                )
                .is_gt()
            })
    });
    items.sort_by(|a, b| compare_key((a.due, a.created_at, &a.id), (b.due, b.created_at, &b.id)));
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    (items, has_more)
}

pub(crate) fn compare_items(a: &ActionInboxItem, b: &ActionInboxItem) -> std::cmp::Ordering {
    compare_key((a.due, a.created_at, &a.id), (b.due, b.created_at, &b.id))
}

pub(crate) fn item_after_cursor(item: &ActionInboxItem, cursor: &ActionInboxCursor) -> bool {
    compare_key(
        (item.due, item.created_at, &item.id),
        (
            cursor.position.due,
            cursor.position.created_at,
            &cursor.position.id,
        ),
    )
    .is_gt()
}

/// One key for source pages, merged rows and their continuations.
pub fn compare_key(
    a: (Option<OffsetDateTime>, OffsetDateTime, &str),
    b: (Option<OffsetDateTime>, OffsetDateTime, &str),
) -> std::cmp::Ordering {
    a.0.is_none()
        .cmp(&b.0.is_none())
        .then_with(|| a.0.cmp(&b.0))
        .then_with(|| a.1.cmp(&b.1))
        .then_with(|| a.2.cmp(b.2))
}

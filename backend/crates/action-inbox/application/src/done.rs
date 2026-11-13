// SPDX-License-Identifier: LicenseRef-Proprietary
//! Done: what the viewer decided or finished, newest first, merged across
//! sources by one keyset `(completed_at, id)`. Separate from the open list:
//! no lane, no count, and nothing here changes what `all` or `turn` return.

use console_kernel_core::KernelError;
use serde::Serialize;
use time::OffsetDateTime;

use crate::ActionInboxLink;

/// Rows per page when the caller names none, and the most it may ask for.
pub const DONE_PAGE_DEFAULT: usize = 50;
pub const DONE_PAGE_MAX: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoneItem {
    /// `"{kind}:{uuid}"`, the same namespaced id the open item had.
    pub id: String,
    pub kind: String,
    pub title: String,
    /// The source's own end state (e.g. APPLIED, DECLINED, APPROVED, REJECTED).
    pub outcome: String,
    #[serde(with = "console_kernel_core::timestamp")]
    pub completed_at: OffsetDateTime,
    pub links: Vec<ActionInboxLink>,
}

/// Where a page starts: strictly older than this `(completed_at, id)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoneCursor {
    pub completed_at: OffsetDateTime,
    pub id: String,
}

impl DoneCursor {
    #[must_use]
    pub fn encode(&self) -> String {
        format!("{}~{}", self.completed_at.unix_timestamp_nanos(), self.id)
    }

    /// # Errors
    /// A cursor this module did not write.
    pub fn decode(raw: &str) -> Result<Self, KernelError> {
        let invalid =
            || KernelError::validation("cursor is not a 완료 cursor").with_field("cursor");
        let (nanos, id) = raw.split_once('~').ok_or_else(invalid)?;
        let nanos: i128 = nanos.parse().map_err(|_| invalid())?;
        let completed_at =
            OffsetDateTime::from_unix_timestamp_nanos(nanos).map_err(|_| invalid())?;
        if id.is_empty() || !id.contains(':') {
            return Err(invalid());
        }
        Ok(Self {
            completed_at,
            id: id.to_owned(),
        })
    }
}

/// The page size asked for, bounded.
#[must_use]
pub fn done_limit(asked: Option<usize>) -> usize {
    asked.unwrap_or(DONE_PAGE_DEFAULT).clamp(1, DONE_PAGE_MAX)
}

/// Newest first across sources. Each source returns at most `limit + 1` rows
/// older than the cursor, so a row past `limit` means another page exists.
#[must_use]
pub fn merge_done(mut items: Vec<DoneItem>, limit: usize) -> (Vec<DoneItem>, Option<DoneCursor>) {
    items.sort_by(|a, b| (b.completed_at, &b.id).cmp(&(a.completed_at, &a.id)));
    let next = (items.len() > limit).then(|| {
        let last = &items[limit - 1];
        DoneCursor {
            completed_at: last.completed_at,
            id: last.id.clone(),
        }
    });
    items.truncate(limit);
    (items, next)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use time::macros::datetime;

    fn item(id: &str, at: OffsetDateTime) -> DoneItem {
        DoneItem {
            id: id.to_owned(),
            kind: id.split(':').next().unwrap().to_owned(),
            title: String::new(),
            outcome: "APPLIED".to_owned(),
            completed_at: at,
            links: vec![],
        }
    }

    #[test]
    fn sources_merge_newest_first_and_the_cursor_names_the_last_row_kept() {
        let (a, b) = (
            datetime!(2026-11-10 09:00 UTC),
            datetime!(2026-11-11 09:00 UTC),
        );
        let (page, next) = merge_done(
            vec![
                item("hr_request:1", a),
                item("period_unlock:2", b),
                item("hr_request:3", b),
            ],
            2,
        );
        assert_eq!(
            page.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["period_unlock:2", "hr_request:3"]
        );
        let next = next.unwrap();
        assert_eq!((next.completed_at, next.id.as_str()), (b, "hr_request:3"));
        assert_eq!(DoneCursor::decode(&next.encode()).unwrap(), next);
        let (all, none) = merge_done(vec![item("hr_request:1", a)], 2);
        assert_eq!((all.len(), none), (1, None));
    }

    #[test]
    fn a_foreign_cursor_and_the_page_size_are_bounded() {
        for raw in [
            "",
            "abc",
            "1~",
            "x~hr_request:1",
            "1~nocolon",
            "eyJkdWUiOm51bGx9",
        ] {
            assert!(DoneCursor::decode(raw).is_err(), "{raw}");
        }
        assert_eq!(
            (
                done_limit(None),
                done_limit(Some(0)),
                done_limit(Some(1000))
            ),
            (DONE_PAGE_DEFAULT, 1, DONE_PAGE_MAX)
        );
    }
}

//! `GET /employees/{id}/lifecycle-events?limit=&cursor=`: a person's history
//! in keyset pages, newest first by `(created_at, id)` (hr-polish A8; it
//! replaces the fixed `LIMIT 200`). A page continues strictly before the last
//! row returned, so an event recorded meanwhile never shifts it.

use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;

/// The page size when none is given: the former fixed window.
pub const DEFAULT_EVENTS_PAGE: i64 = 200;
pub const MAX_EVENTS_PAGE: i64 = 500;

#[derive(Debug, Default, Deserialize)]
pub struct LifecycleEventsQuery {
    pub limit: Option<i64>,
    /// The previous page's `next_cursor`.
    pub cursor: Option<String>,
}

/// The validated page: its size and the `(created_at, id)` it continues before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LifecycleEventsPage {
    pub limit: i64,
    pub before: Option<(OffsetDateTime, Uuid)>,
}

fn invalid_cursor() -> HrError {
    HrError::validation("cursor is not a cursor this history returned")
}

/// Opaque on the wire: `<unix nanos>~<id>`.
pub fn encode_events_cursor(created_at: OffsetDateTime, id: Uuid) -> String {
    format!("{}~{id}", created_at.unix_timestamp_nanos())
}

impl LifecycleEventsQuery {
    pub fn page(&self) -> Result<LifecycleEventsPage, HrError> {
        let limit = self
            .limit
            .unwrap_or(DEFAULT_EVENTS_PAGE)
            .clamp(1, MAX_EVENTS_PAGE);
        let before = self
            .cursor
            .as_deref()
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
            .map(|raw| {
                let (nanos, id) = raw.split_once('~').ok_or_else(invalid_cursor)?;
                let at = nanos
                    .parse::<i128>()
                    .ok()
                    .and_then(|n| OffsetDateTime::from_unix_timestamp_nanos(n).ok())
                    .ok_or_else(invalid_cursor)?;
                Ok::<_, HrError>((at, Uuid::parse_str(id).map_err(|_| invalid_cursor())?))
            })
            .transpose()?;
        Ok(LifecycleEventsPage { limit, before })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn cursor_round_trips_and_bad_ones_are_refused() {
        let at = OffsetDateTime::from_unix_timestamp_nanos(1_790_000_000_123_456_789).unwrap();
        let id = Uuid::from_u128(7);
        let query = LifecycleEventsQuery {
            limit: Some(9_999),
            cursor: Some(encode_events_cursor(at, id)),
        };
        assert_eq!(
            query.page().unwrap(),
            LifecycleEventsPage {
                limit: MAX_EVENTS_PAGE,
                before: Some((at, id))
            }
        );
        for bad in [
            "x",
            "12~nope",
            "~",
            "abc~00000000-0000-0000-0000-000000000007",
        ] {
            let query = LifecycleEventsQuery {
                limit: None,
                cursor: Some(bad.to_owned()),
            };
            assert!(query.page().is_err(), "{bad}");
        }
        assert_eq!(
            LifecycleEventsQuery::default().page().unwrap().limit,
            DEFAULT_EVENTS_PAGE
        );
    }
}

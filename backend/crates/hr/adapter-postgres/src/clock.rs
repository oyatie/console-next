//! The org-local business date. The only clock read in the HR context.

use time::{Date, OffsetDateTime};

/// Today in the org-local business calendar (KST), for effective-date rules.
pub fn today_kst() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(time::macros::offset!(+9))
        .date()
}

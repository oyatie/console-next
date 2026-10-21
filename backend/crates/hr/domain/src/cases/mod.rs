//! Lifecycle cases (lifecycle-events.md §2, §5): every lifecycle event opens a
//! case of typed items. This module holds the item vocabulary, the typed item
//! statuses and the due clocks; the tables are migration 0314.

pub mod clocks;
pub mod model;
pub mod status;

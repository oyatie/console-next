//! Org-change lifecycle vocabulary (STORY-ORG-001, HANDOFF §15/§16).
//!
//! Pure state machine + typed proposal ops + wire DTOs for the org-change
//! engine: draft → preflight → ordered SoD approval → effective-dated apply.
//! No IO here; the adapter owns persistence, the rest crate owns HTTP.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

// The workspace `time` build has no `serde-human-readable`, so a bare `Date`
// would hit the wire as `[year, ordinal]`; this pins the ISO calendar date.
time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

mod decision;
mod dto;
pub mod projection;
mod proposal;
mod schedule;
mod status;
mod tree_order;

pub use decision::*;
pub use dto::*;
pub use proposal::*;
pub use schedule::*;
pub use status::*;
pub use tree_order::*;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod proposal_tests;

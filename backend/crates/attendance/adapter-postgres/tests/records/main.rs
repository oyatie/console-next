#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! 근태 기록 (ATT S2) against Postgres with RLS, one test binary.

mod closed_month;
mod closed_month_db_guard;
mod closed_month_order;
mod conflict;
mod detail;
mod edits;
mod grammar;
mod long_spans;
mod save;
mod security;
mod security_support;
#[path = "../schedule/support.rs"]
mod support;
mod thresholds;
mod unscheduled;

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Work schedule (ATT S1) against Postgres with RLS, one test binary.

mod break_floor;
mod calendar;
mod calendar_refusals;
mod layers;
mod refusals;
mod stored_order;
mod support;
mod tree;

// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Acceptance and negative tests for LMG-PLACE-A-IMPORT-ROUTING.
//!
//! Acceptance:
//! - Importing a sheet placing 3 people in 본사 -> each has home_branch_id = 본사's default branch
//!   and home_branch_review_required lists 0 of them;
//! - An attendance/leave routing read for an imported person resolves the branch.
//! - An expand-only, idempotent backfill sets it for current employees with a live assignment
//!   and a NULL home branch (re-run = no change).

#[path = "../emp_create/fixture.rs"]
mod fixture;
#[path = "../import2/harness.rs"]
mod harness;

mod backfill;
mod definer_guards;
mod import_acceptance;
mod legacy_settle;
mod shared;
mod trigger_boundaries;

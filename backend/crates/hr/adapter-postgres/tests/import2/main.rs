#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! IMPORT-2 (decisions #25, #26) on a `console_rt` pool: the sealed
//! resident registration number and its tombstone, any-layout import, the
//! needs-review queue, mapping memory, employee number change and
//! renumbering.

mod apply_authorization;
mod apply_progress;
mod atomic_apply;
mod company_names;
mod field_reveal;
#[path = "../emp_create/fixture.rs"]
mod fixture;
mod flow;
mod harness;
mod identity;
mod memory;
mod mig_job;
mod mig_reconcile;
mod mig_roster;
mod mig_unplaced;
mod mig_values;
mod number;
mod r3_answers;
mod r3_cap;
mod r3_facts;
mod r3_import;
mod reconcile;
mod rollback;
mod rollback_burst;
mod rrn_audit;
mod rrn_governed;
mod rrn_plaintext;
mod rrn_read;
mod rrn_tombstone;
mod statistics;

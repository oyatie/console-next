//! Employee import (moved from `app/src/hr.rs`, R2-import). The calamine
//! workbook readers and the multipart upload stay in `app` until Tier 1 step 4.

pub mod apply;
pub mod apply_drive;
pub mod apply_job;
pub mod apply_resume;
pub mod apply_rows;
pub mod canonical;
pub mod dry_run;
pub mod header;
pub mod identity;
pub mod mask;
pub mod parsed;
pub mod persist;
pub mod plan_facts;
pub mod preview;
pub mod run_record;
pub mod settle;
pub mod settle_facts;
mod statistics;
pub mod store;
pub mod types;

// --- lane: IMPORT-2 ---
pub mod caps;
pub mod identities;
pub mod memory;
pub mod phones;
pub mod review;
pub mod settle_setup;
pub mod sheet;
pub mod workbook;

// --- lane: BE-EMP-UI ---
pub mod reconcile;
mod reconcile_company;
pub mod reconcile_rows;
pub mod reconcile_write;

// --- lane: BE-MIG (E8) ---
pub mod unplaced;

// --- lane: UX-R3 IMPORT ---
pub mod apply_report;
pub mod company;

//! HR context, Postgres adapter: SQL, transactions and the `HrService` facade
//! the REST handlers call (backend-module-map §1.3). This file holds `mod` and
//! `pub use` lines only, in per-lane sections.

// --- lane: R2 shared ---
mod error;
pub use error::{FieldError, HrError};
mod service;
pub use service::HrService;
pub mod authz;
pub mod clock;
pub mod digest;
pub mod directory;
pub mod exits;
pub mod idempotency;
pub mod import;
pub mod lifecycle;
pub mod metrics;
pub mod paging;
pub mod scope_sql;

// --- lane: EMP-RECORD ---
pub mod record;
// --- lane: EMP-MODEL ---
pub mod checklist;
pub mod contract;
pub mod profile;
// --- lane: LIFE ---
pub mod bulk_corrections;
pub mod change_sets;
pub mod job_title;
// --- lane: PEOPLE-A ---
pub mod corrections;
pub mod registration_void;
pub mod requests;

// --- lane: EMP-FACTS ---
pub mod register_facts;
// --- lane: EMP-FACTS MR-34 ---
pub mod personal_facts;
// --- lane: IMPORT-2 ---
pub mod employee_number;
pub mod rrn;

// --- lane: BE-EMP-UI ---
pub mod notices;

// --- lane: UX-R2 GUARDS ---
pub mod own_record;
// --- lane: LC-B3 ---
pub mod cases;

// --- lane: CX-statutory ---
pub mod statutory;

// --- lane: F5 ---
pub mod certificates;

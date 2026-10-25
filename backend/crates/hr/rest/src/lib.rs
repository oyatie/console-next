//! HR context, inbound HTTP: extractors, routers and the one `IntoResponse`
//! for `HrError`. No SQL (layer-boundary Rest rule). This file holds `mod`,
//! `pub use` and router lines only, in per-lane sections.

// --- lane: R2 shared ---
mod error;
pub use error::HrApiError;

// --- lane: EMP-RECORD ---
pub mod record;
// --- lane: EMP-MODEL ---
pub mod checklist;
pub mod contract;
pub mod profile;
// --- lane: LIFE ---
// --- lane: PEOPLE-A ---
pub mod bulk_corrections;
pub mod change_sets;
pub mod corrections;
pub mod exit_guards;
pub mod fixed_term;
pub mod job_title;
pub mod lifecycle_void;
pub mod requests;
// --- lane: PEOPLE-B ---
mod directory;
pub use directory::{employee_facets, export_employees_csv};

// --- lane: EMP-CREATE ---
pub mod registration;

// --- lane: IMPORT ---
pub mod import_runs;
pub mod intake;

// --- lane: EMP-FACTS ---
pub mod register_facts;

// --- lane: EMP-FACTS MR-34 ---
pub mod personal_facts;

// --- lane: IMPORT-2 ---
pub mod identity;

// --- lane: BE-EMP-UI ---
pub mod bulk_lifecycle;
pub mod notices;
pub mod reconcile;

// --- lane: PERF-BE ---
pub mod lifecycle_bulk_job;

// --- lane: CX-statutory ---
pub mod statutory;

// --- lane: F5 ---
pub mod certificates;

// --- lane: ECO-G5 ---
pub mod person_binding;
// --- lane: LC-B4 ---
pub mod cases;

//! Lifecycle: the write core shared by the lifecycle and exit paths (moved
//! from `app/src/hr.rs` in R2-exits; R2-life moves the handlers).

pub mod prepare;
pub mod record;
pub mod rows;
pub mod rules;
pub mod schedule_sql;
pub mod store;
pub mod types;

// --- lane: R2-life ---
mod apply_due;
mod audit;
mod bulk;
mod cancel;
mod events;
pub mod normalize;
pub mod requests;

// --- lane: LIFE ---
pub mod classification;
pub mod correct;
pub mod fixed_term;
pub mod group_transfer;
pub mod guards;
pub mod hooks;
mod insert;
pub mod placement;
pub mod title_reason;
pub mod void;
// --- lane: PEOPLE-READS-2 ---
pub mod bulk_selection;
pub mod events_page;
// --- lane: BE-EMP-UI ---
mod batch_undo;
mod bulk_plan;
pub mod bulk_preview;
// --- lane: UX-R2 ENDS ---
pub mod close_plan;
// --- lane: PERF-BE ---
pub mod bulk_job;
mod bulk_job_read;
mod bulk_job_slot;

//! Lifecycle event rules, transitions, sign-offs and schedule projection.

pub mod fixed_term;
pub mod fixed_term_exemption;

// --- lane: R2 shared (moved from app/src/hr.rs) ---
pub mod event;
pub mod schedule;
pub mod signoffs;
pub mod transition;

// --- lane: LIFE ---
pub mod childcare;
pub mod classification;
pub mod group_transfer;
pub mod job_title;
pub mod leave_facts;
pub mod rehire;

//! HR bounded context, ring 1 (entities and pure rules).
//!
//! Subdomains are modules, not crates. This file holds `mod` and `pub use`
//! lines only. Depends on `console-kernel-core` and `time`; no IO, no clock
//! reads (`now` is a parameter), no settings or register lookups (values are
//! parameters).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod employee;
pub mod exits;
pub mod import;
pub mod lifecycle;
pub mod text;

// --- lane: EMP-RECORD ---
pub mod record;
// --- lane: EMP-MODEL ---
pub mod checklist;
pub mod contract;
pub mod profile;
// --- lane: PEOPLE-A ---
pub mod corrections;
pub mod registration_void;
pub mod requests;

// --- lane: EMP-FACTS ---
pub mod register;

// --- lane: EMP-FACTS MR-34 ---
pub mod personal;

// --- lane: LC-B3 ---
pub mod cases;

// --- lane: CX-statutory ---
pub mod filing;

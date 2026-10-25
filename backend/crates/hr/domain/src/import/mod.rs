//! Employee import: header detection, PII classification, masking.

// --- lane: R2-import (moved from app/src/hr.rs) ---
pub mod classification;
pub mod company_review;
pub mod fields;
pub mod fields_org;
mod fields_place;
pub mod pii;
pub mod rollback;
pub mod rrn;

// --- lane: IMPORT (BW-10) ---
pub mod cells;
pub mod plan;
pub mod plan_people;
mod plan_place;
pub mod plan_rows;
pub mod workbook;

// --- lane: IMPORT-2 ---
pub mod detect;
mod detect_candidates;
pub mod grid;
pub mod guard;
pub mod normalize;
pub mod numbering;
mod plan_identity;
mod plan_status;
pub mod review;
mod review_values;
pub mod rrn_value;

// --- lane: BE-MIG (walkthrough W02/W03/W05/W12) ---
pub mod names;
pub mod plan_group;
pub mod roster_cells;
pub mod summary;

// --- lane: UX-R3 IMPORT ---
mod fields_register;
pub mod sex;

//! 법인 · 사업자등록 · 사업장 domain (entity-depth design §2–§3).
//!
//! Pure: typed inputs are validated into drafts the adapter stores as
//! append-only, effective-dated revisions. Every refusal carries a stable code
//! and, where a person can act, a remedy. Consequential facts have no
//! defaults; a value the facts already decide (one registration ⇒ no 총괄납부
//! question) is derived and stored with its basis, which is not a default.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod address;
pub mod business_type;
pub mod codes;
pub mod correction;
pub mod cross_entity;
pub mod document;
pub mod insurance;
pub mod insurance_change;
pub mod legal_entity;
pub mod names;
pub mod refusal;
pub mod registration;
pub mod registration_classification;
pub mod registration_number;
mod registration_vat;
pub mod reissue;
pub mod revision_reason;
pub mod structure_code;
pub mod suspension;
pub mod workplace;
pub mod workplace_kind;
pub mod workplace_registration;

pub use address::{AddressInput, KrAddress};
pub use refusal::{FieldIssue, Issues, Refusal, Warning};
pub use revision_reason::{PersonReason, RevisionReason, SystemReason};

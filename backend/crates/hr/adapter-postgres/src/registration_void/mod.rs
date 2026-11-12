//! MR-26 registration void: a record that should never have existed.
//!
//! - SETUP: [`HrService::setup_delete_employee`] voids and tombstones at
//!   once and frees the employee number (nothing can reference it before
//!   go-live).
//! - After go-live: [`HrService::void_employee`], governed like a high-risk
//!   correction (second person, or a sole holder's step-up with the review
//!   flag); the personal data goes after `people.void_pii_retention`
//!   ([`HrService::destroy_due_void_pii`]).
//! - [`HrService::list_voided`] is the "voided registrations" list.
//!
//! A voided row is hidden from every runtime read by 0277's `hide_voided`
//! policy; the `employees` writes go through the canonical owner
//! (`employee_void`).

mod apply;
// --- lane: CRUD ---
pub mod ends;
mod facts;
pub mod list;
pub mod purge;
mod setup_delete;
mod void;

pub use apply::apply_requested_void_in_tx;
pub(crate) use apply::{void_event, void_in_tx};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::requests::ChangeRequestResponse;

/// `DELETE /api/v1/employees/{id}` during SETUP.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupDeleteRequest {
    /// The employee's `updated_at` as last read (RFC 3339).
    pub expected_updated_at: String,
    pub reason_code: String,
    /// An EXITED person inside the worker register period: the actor confirms
    /// the tenant keeps its original register (onboarding design §7.3).
    #[serde(default)]
    pub register_kept: bool,
}

/// `POST /api/v1/employees/{id}/void` after go-live.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoidEmployeeRequest {
    pub expected_updated_at: String,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// "Never worked": required unless the person is PRE_HIRE.
    #[serde(default)]
    pub attest_never_worked: bool,
    /// A sole holder's void: a step-up bound to this employee and
    /// [`void_payload`] (decisions #7 case B).
    #[serde(default)]
    pub step_up: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct VoidOutcome {
    pub employee_id: Uuid,
    /// VOIDED now, or PENDING a second person.
    pub status: &'static str,
    #[serde(with = "time::serde::rfc3339::option")]
    pub voided_at: Option<OffsetDateTime>,
    /// A sole holder voided: reviewed after the fact.
    pub review_required: bool,
    pub pending_request: Option<ChangeRequestResponse>,
}

/// The canonical payload a sole holder's void step-up signs and a filed
/// request carries: keys sorted, no whitespace.
#[must_use]
pub fn void_payload(attest_never_worked: bool) -> String {
    format!(r#"{{"attest_never_worked":{attest_never_worked}}}"#)
}

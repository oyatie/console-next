//! BW-18 employee master-data corrections (정정) and identity resolution.
//! Lane PEOPLE-A.
//!
//! `employees` writes go through the Employment owner
//! (`console_ontology_canonical_adapter_postgres::employee_correction`); this
//! module locks, compares versions, decides the path and writes the ledger.

pub mod apply;
pub(crate) mod catalog;
mod fields;
mod head;
pub mod identity;
pub mod merge;
pub mod patch;
mod profile;
mod write;

use console_hr_domain::corrections::{
    CorrectionRoute, HighRiskPath, correction_route, high_risk_path,
};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;
use crate::requests::ChangeRequestResponse;

pub use apply::apply_requested_correction_in_tx;
pub(crate) use fields::normalize_value;
pub(crate) use head::{LockedEmployee, lock_employee, read_employee};
pub(crate) use write::{
    FieldValue, LedgerMeta, apply_fields_in_tx, check_against_record, ledger_value,
};

impl crate::HrService {
    /// The pool, for the REST caller that computes the [`SecondPersonContext`]
    /// this module takes as input (identity's fact, resolved settings).
    #[must_use]
    pub const fn pool(&self) -> &sqlx::PgPool {
        &self.pool
    }
}

/// The BW-29 second-person facts for an org-wide HR act, computed by the
/// caller (identity's D0.2 count, the resolved `authz.sole_holder.mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecondPersonContext {
    /// Eligible holders other than the actor.
    pub other_eligible_holders: u64,
    /// `authz.sole_holder.mode = refuse`.
    pub sole_holder_refuse: bool,
    /// `approval.policy.<class> = route` for this act (decisions #26).
    /// `false` (`none`): no second person; the actor applies it after the
    /// sole holder's step-up, flagged for review.
    pub routed: bool,
}

impl SecondPersonContext {
    /// The high-risk path these facts give (`None`: refused).
    #[must_use]
    pub const fn path(&self) -> Option<HighRiskPath> {
        high_risk_path(
            self.other_eligible_holders,
            self.sole_holder_refuse,
            self.routed,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrectEmployeeRequest {
    /// The employee's `updated_at` as last read (RFC 3339).
    pub expected_updated_at: String,
    pub changes: Map<String, Value>,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
    /// A sole holder's high-risk correction: a step-up bound to this employee
    /// and [`patch::correction_payload`] of `changes` (decisions #7 case B).
    #[serde(default)]
    pub step_up: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct CorrectionOutcome {
    pub employee_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// Fields changed now.
    pub applied: Vec<String>,
    /// A sole holder applied a high-risk field: reviewed after the fact.
    pub review_required: bool,
    /// High-risk fields waiting for a second person (BW-17 request).
    pub pending_request: Option<ChangeRequestResponse>,
}

pub(crate) fn refusal(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> HrError {
    HrError {
        errors: None,
        status,
        code,
        message: message.into(),
        refusals: None,
    }
}

/// The route of `field`, refusing one that cannot be corrected yet (409) so no
/// request is ever filed that could not be applied.
pub fn route_or_refuse(field: &str) -> Result<CorrectionRoute, HrError> {
    match correction_route(field)? {
        CorrectionRoute::Unavailable(why) => Err(refusal(
            StatusCode::CONFLICT,
            "employee_correction_unavailable",
            format!("{field}: {why}"),
        )),
        route => Ok(route),
    }
}

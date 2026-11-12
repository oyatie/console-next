//! BW-18 employee master-data corrections: which field takes which path,
//! and the second-person / sole-holder choice for high-risk fields.
//!
//! Pure: the holder count and the `authz.sole_holder.mode` setting arrive as
//! parameters (plan D2); the adapter maps each refusal to its wire code.

use console_kernel_core::KernelError;

pub mod bulk;
pub mod catalog;

/// How a correction of one field is decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrectionRoute {
    /// Applied by the HR person at once.
    Low,
    /// A second person through a BW-17 request when another holder exists;
    /// otherwise the sole holder applies it with the review flag (decisions
    /// #7 case B: correction of pay or dates; #6: employee number).
    High,
    /// Cannot be corrected here; the string names the path that changes it.
    Unavailable(&'static str),
}

const POSITION_VIA_LIFECYCLE: &str =
    "position_id changes through a promotion or transfer, not a correction";
/// The text twins are display snapshots of the employment assignment (the
/// legal entity/workplace placement) and of the department binding;
/// correcting the text alone would make them disagree with the record they
/// mirror.
const PLACEMENT_VIA_ASSIGNMENT: &str = "the 법인, 사업장 and 부서 change through the employment assignment (re-bind as a correction, or a TRANSFER), not a text correction";

/// Every scalar field of the employee record and its route. One table: the
/// PATCH, a filed PROFILE_CORRECTION and the facts PATCH all read it.
pub const CORRECTABLE_FIELDS: [(&str, CorrectionRoute); 35] = [
    ("name", CorrectionRoute::Low),
    ("phone", CorrectionRoute::Low),
    ("job", CorrectionRoute::Low),
    ("grade_id", CorrectionRoute::Low),
    ("job_title_id", CorrectionRoute::Low),
    ("position_kind_id", CorrectionRoute::Low),
    ("job_id", CorrectionRoute::Low),
    ("job_family_id", CorrectionRoute::Low),
    ("work_email", CorrectionRoute::Low),
    ("id_type", CorrectionRoute::Low),
    ("hire_date", CorrectionRoute::High),
    ("exit_date", CorrectionRoute::High),
    ("birth_date", CorrectionRoute::High),
    ("employee_number", CorrectionRoute::High),
    ("employment_type", CorrectionRoute::High),
    ("base_pay", CorrectionRoute::High),
    ("pay_unit", CorrectionRoute::High),
    ("probation_end_date", CorrectionRoute::High),
    (
        "position_id",
        CorrectionRoute::Unavailable(POSITION_VIA_LIFECYCLE),
    ),
    (
        "company",
        CorrectionRoute::Unavailable(PLACEMENT_VIA_ASSIGNMENT),
    ),
    (
        "worksite_name",
        CorrectionRoute::Unavailable(PLACEMENT_VIA_ASSIGNMENT),
    ),
    (
        "worksite_address",
        CorrectionRoute::Unavailable(PLACEMENT_VIA_ASSIGNMENT),
    ),
    (
        "org_unit",
        CorrectionRoute::Unavailable(PLACEMENT_VIA_ASSIGNMENT),
    ),
    // Worker register items (MR-23; Labor Standards Act §41, Enforcement
    // Decree §20 items 2·4·5·8·9). The exit reason is high-risk once recorded:
    // an involuntary code on the register is a second person's call.
    ("sex", CorrectionRoute::Low),
    ("address", CorrectionRoute::Low),
    ("careers", CorrectionRoute::Low),
    ("register_note", CorrectionRoute::Low),
    ("exit_reason", CorrectionRoute::High),
    // Personal details extras (MR-34). The group hire date starts the period
    // of continuous service (Labor Standards Act §60 annual leave, Employee
    // Retirement Benefit Security Act §8 severance pay), so changing a
    // recorded one is a second person's call like the hire date.
    ("name_hanja", CorrectionRoute::Low),
    ("name_en", CorrectionRoute::Low),
    ("nationality", CorrectionRoute::Low),
    ("personal_email", CorrectionRoute::Low),
    ("emergency_contacts", CorrectionRoute::Low),
    ("photo", CorrectionRoute::Low),
    ("group_service_start_date", CorrectionRoute::High),
];

/// The route of one PATCH / PROFILE_CORRECTION field. An unknown field is a
/// validation error.
// position_id needs an Employment correction target in ontology
// (canonical revisions own the position); until then it is refused.
pub fn correction_route(field: &str) -> Result<CorrectionRoute, KernelError> {
    CORRECTABLE_FIELDS
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, route)| *route)
        .ok_or_else(|| {
            KernelError::validation(format!("{field} is not a correctable field"))
                .with_field("changes")
        })
}

/// The route once the current value is known: writing a field that holds no
/// value yet is its first recording, not a correction, so no second person is
/// needed (the EMP-MODEL pay set-once rule, applied to every field).
#[must_use]
pub const fn route_for_current(route: CorrectionRoute, recorded: bool) -> CorrectionRoute {
    match route {
        CorrectionRoute::High if !recorded => CorrectionRoute::Low,
        other => other,
    }
}

/// How a high-risk act (a hire-date correction, an identity merge) proceeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HighRiskPath {
    /// Another eligible holder exists: a BW-17 request, decided by them.
    SecondPerson,
    /// The actor is the only holder: applied now, flagged for review.
    SoleHolderReview,
}

/// `other_eligible_holders` is the BW-29 D0.2 count excluding the actor.
/// `routed` is `approval.policy.<class> = route` (decisions #26); under
/// `none` no second person is required, so the actor applies the change
/// after the sole holder's step-up, flagged for review.
/// `None` means `authz.sole_holder.mode = refuse` and no other holder.
#[must_use]
pub const fn high_risk_path(
    other_eligible_holders: u64,
    sole_holder_refuse: bool,
    routed: bool,
) -> Option<HighRiskPath> {
    if !routed {
        Some(HighRiskPath::SoleHolderReview)
    } else if other_eligible_holders > 0 {
        Some(HighRiskPath::SecondPerson)
    } else if sole_holder_refuse {
        None
    } else {
        Some(HighRiskPath::SoleHolderReview)
    }
}

/// The verdict on an identity-review record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityVerdict {
    /// The same natural person: merge into the kept record (step-up).
    Same,
    /// Different people: clear the review flag.
    Different,
}

impl IdentityVerdict {
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        match raw {
            "SAME" => Ok(Self::Same),
            "DIFFERENT" => Ok(Self::Different),
            _ => {
                Err(KernelError::validation("verdict must be SAME or DIFFERENT")
                    .with_field("verdict"))
            }
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Same => "SAME",
            Self::Different => "DIFFERENT",
        }
    }
}

#[cfg(test)]
mod tests;

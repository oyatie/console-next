//! MR-27 bulk 정정: how one field and one row of a bulk correction proceed,
//! once the value has been compared with the record. Pure; the adapter
//! supplies the route ([`super::route_for_current`]) and the second-person
//! path ([`super::high_risk_path`]).

use super::{CorrectionRoute, HighRiskPath};

/// How a field whose value differs from the record is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldPath {
    /// Applied at commit (a low-risk field, or a first recording).
    Now,
    /// Filed as a BW-17 request for another holder to decide.
    SecondPerson,
    /// Applied at commit by the sole holder after a step-up, flagged for review.
    SoleHolderReview,
}

impl FieldPath {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Now => "NOW",
            Self::SecondPerson => "SECOND_PERSON",
            Self::SoleHolderReview => "SOLE_HOLDER_REVIEW",
        }
    }
}

/// The path of a differing field given its route once the record is known.
/// `None`: a high-risk field the organization lets nobody decide (sole holder
/// in `refuse` mode), or a field that cannot be corrected at all.
#[must_use]
pub const fn field_path(route: CorrectionRoute, high: Option<HighRiskPath>) -> Option<FieldPath> {
    match (route, high) {
        (CorrectionRoute::Low, _) => Some(FieldPath::Now),
        (CorrectionRoute::High, Some(HighRiskPath::SecondPerson)) => Some(FieldPath::SecondPerson),
        (CorrectionRoute::High, Some(HighRiskPath::SoleHolderReview)) => {
            Some(FieldPath::SoleHolderReview)
        }
        _ => None,
    }
}

/// What a bulk correction does to one employee.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowOutcome {
    /// Every differing field is written at commit.
    Change,
    /// At least one field waits for a second person (the rest are written).
    Pending,
    /// Every value already equals the record: nothing is written.
    Unchanged,
    /// A precondition fails: nothing is written for this employee.
    Refused,
}

impl RowOutcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Change => "CHANGE",
            Self::Pending => "PENDING",
            Self::Unchanged => "UNCHANGED",
            Self::Refused => "REFUSED",
        }
    }

    /// The outcome of a row that passed its preconditions.
    #[must_use]
    pub fn of(paths: &[FieldPath]) -> Self {
        if paths.is_empty() {
            Self::Unchanged
        } else if paths.contains(&FieldPath::SecondPerson) {
            Self::Pending
        } else {
            Self::Change
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_fields_apply_now_and_high_fields_follow_the_holder_path() {
        let low = CorrectionRoute::Low;
        let high = CorrectionRoute::High;
        assert_eq!(field_path(low, None), Some(FieldPath::Now));
        assert_eq!(
            field_path(high, Some(HighRiskPath::SecondPerson)),
            Some(FieldPath::SecondPerson)
        );
        assert_eq!(
            field_path(high, Some(HighRiskPath::SoleHolderReview)),
            Some(FieldPath::SoleHolderReview)
        );
        assert_eq!(field_path(high, None), None);
        assert_eq!(field_path(CorrectionRoute::Unavailable("x"), None), None);
    }

    #[test]
    fn a_row_is_unchanged_without_differences_and_pending_with_a_second_person() {
        assert_eq!(RowOutcome::of(&[]), RowOutcome::Unchanged);
        assert_eq!(
            RowOutcome::of(&[FieldPath::Now, FieldPath::SoleHolderReview]),
            RowOutcome::Change
        );
        assert_eq!(
            RowOutcome::of(&[FieldPath::Now, FieldPath::SecondPerson]),
            RowOutcome::Pending
        );
    }
}

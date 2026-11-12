// SPDX-License-Identifier: LicenseRef-Proprietary
//! Dated residence facts, independent of insurance and permission to work.
//! Intervals are [valid_from, valid_to); callers supply the official catalog
//! and this employee's history after authorization, excluding a row being replaced.
//! Nationality comes from validated personal facts (normalized ISO code).
use console_kernel_core::KernelError;
use time::Date;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidenceStatus {
    pub code: String,
    pub valid_from: Date,
    pub valid_to: Option<Date>,
}

/// Membership periods from the migration-owned official reference catalog.
#[derive(Debug, Clone)]
pub struct StatusVersion {
    pub code: String,
    pub valid_from: Date,
    pub valid_to: Option<Date>,
}

fn refusal(code: &'static str, field: &str, message: &str) -> KernelError {
    KernelError::validation(message)
        .with_code(code)
        .with_field(field)
}

/// Validate a new or corrected fact against the employee and official edition.
/// Historical rows remain after a later nationality change.
/// `catalog_country` comes from `residence_status_codes.country_code`; versions
/// must belong to that jurisdiction. Membership before coverage uses its first edition.
/// # Errors
/// Missing/domestic nationality, invalid dates, unknown code or overlapping history.
pub fn validate(
    status: &ResidenceStatus,
    nationality: Option<&str>,
    catalog_country: &str,
    catalog: &[StatusVersion],
    history: &[ResidenceStatus],
) -> Result<(), KernelError> {
    match nationality {
        None => {
            return Err(refusal(
                "residence_status_nationality_required",
                "nationality",
                "facts.residence.refuse.nationality_required",
            ));
        }
        Some(country) if country == catalog_country => {
            return Err(refusal(
                "residence_status_not_applicable",
                "nationality",
                "facts.residence.refuse.not_applicable",
            ));
        }
        Some(_) => {}
    }
    if status.valid_to.is_some_and(|end| end <= status.valid_from) {
        return Err(refusal(
            "residence_status_dates",
            "valid_to",
            "facts.residence.refuse.dates",
        ));
    }
    // The first verified edition is coverage, not each code's introduction date.
    let membership_on = catalog
        .iter()
        .map(|version| version.valid_from)
        .min()
        .map_or(status.valid_from, |start| status.valid_from.max(start));
    if !catalog.iter().any(|version| {
        version.code == status.code
            && version.valid_from <= membership_on
            && version.valid_to.is_none_or(|end| membership_on < end)
    }) {
        return Err(refusal(
            "residence_status_unknown",
            "code",
            "facts.residence.refuse.unknown",
        ));
    }
    if history.iter().any(|old| {
        old.valid_to.is_none_or(|end| status.valid_from < end)
            && status.valid_to.is_none_or(|end| old.valid_from < end)
    }) {
        return Err(overlap());
    }
    Ok(())
}

fn overlap() -> KernelError {
    refusal(
        "residence_status_overlap",
        "valid_from",
        "facts.residence.refuse.overlap",
    )
}

/// Find the employee's residence status on a supplied date; gaps stay unknown.
/// This is a fact lookup, never an insurance or employment eligibility decision.
/// # Errors
/// Ambiguous overlapping history fails closed.
pub fn in_force(
    history: &[ResidenceStatus],
    on: Date,
) -> Result<Option<&ResidenceStatus>, KernelError> {
    let mut matches = history
        .iter()
        .filter(|row| row.valid_from <= on && row.valid_to.is_none_or(|end| on < end));
    let first = matches.next();
    if matches.next().is_some() {
        return Err(overlap());
    }
    Ok(first)
}

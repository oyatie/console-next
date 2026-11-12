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
/// # Errors
/// Missing/Korean nationality, invalid dates, unknown code or overlapping history.
pub fn validate(
    status: &ResidenceStatus,
    nationality: Option<&str>,
    catalog: &[StatusVersion],
    history: &[ResidenceStatus],
) -> Result<(), KernelError> {
    match nationality {
        None => {
            return Err(refusal(
                "residence_status_nationality_required",
                "nationality",
                "체류자격을 기록하기 전에 국적을 입력해 주세요.",
            ));
        }
        Some("KR") => {
            return Err(refusal(
                "residence_status_not_applicable",
                "nationality",
                "대한민국 국적 직원에게는 체류자격을 기록할 수 없습니다.",
            ));
        }
        Some(_) => {}
    }
    if status.valid_to.is_some_and(|end| end <= status.valid_from) {
        return Err(refusal(
            "residence_status_dates",
            "valid_to",
            "종료일은 시작일 이후여야 합니다.",
        ));
    }
    if !catalog.iter().any(|version| {
        version.code == status.code
            && version.valid_from <= status.valid_from
            && version.valid_to.is_none_or(|end| status.valid_from < end)
    }) {
        return Err(refusal(
            "residence_status_unknown",
            "code",
            "시작일에 유효한 공식 체류자격을 선택해 주세요.",
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
        "이미 기록된 체류자격 기간과 겹칩니다.",
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

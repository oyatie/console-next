// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{ContractRow, ContractTerms, validate_terms};
use console_kernel_core::KernelError;
use time::Date;

/// Correcting the existing contract endpoint cannot erase facts it does not accept yet.
/// # Errors
/// Refuses a corrected period that no longer contains the recorded effective date.
pub fn correction_terms(
    original: &ContractTerms,
    mut corrected: ContractTerms,
) -> Result<ContractTerms, KernelError> {
    corrected.daily_minutes = original.daily_minutes;
    corrected.scheduled_days_per_week = original.scheduled_days_per_week;
    corrected.weekly_paid_minutes = original.weekly_paid_minutes;
    corrected.terms_effective_from = original.terms_effective_from;
    validate_terms(&corrected)?;
    Ok(corrected)
}

/// Selects one dated record, preserving the existing all-dates correction semantics.
/// Only a later explicit effective date retains its predecessor until that day.
/// # Errors
/// Refuses a lost/backdated effective date or multiple candidates; never ranks wages.
pub fn terms_on(rows: &[ContractRow], day: Date) -> Result<Option<&ContractRow>, KernelError> {
    for row in rows {
        if let Some(previous) = rows.iter().find(|r| Some(r.id) == row.supersedes_id)
            && previous
                .terms
                .terms_effective_from
                .is_some_and(|on| row.terms.terms_effective_from.is_none_or(|next| next < on))
        {
            return Err(KernelError::conflict(
                "a dated replacement must retain or advance its effective date",
            )
            .with_code("contract_terms_date_lost"));
        }
    }
    let mut candidates = rows.iter().filter(|row| {
        let from = row
            .terms
            .terms_effective_from
            .unwrap_or(row.terms.start_date);
        from <= day
            && row.terms.end_date.is_none_or(|end| day <= end)
            && !rows.iter().any(|next| {
                next.supersedes_id == Some(row.id)
                    && next.terms.terms_effective_from.is_none_or(|on| on <= day)
            })
    });
    let selected = candidates.next();
    if candidates.next().is_some() {
        return Err(
            KernelError::conflict("multiple contract terms cover the requested date")
                .with_code("contract_terms_ambiguous"),
        );
    }
    Ok(selected)
}

/// Exact hours ratio, retained until the consumer applies its required rounding convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthlyStandardHours {
    pub numerator: i64,
    pub denominator: i64,
}

/// 근로기준법 시행령 §6②3·4: (weekly scheduled + paid minutes) × 365 / (7 × 12 × 60).
/// https://www.law.go.kr/LSW/lsLinkCommonInfo.do?lsJoLnkSeq=1031431415
/// Missing schedule facts never imply full-time hours or a paid holiday.
#[must_use]
pub fn monthly_standard_hours(terms: &ContractTerms) -> Option<MonthlyStandardHours> {
    terms.daily_minutes?;
    terms.scheduled_days_per_week?;
    Some(MonthlyStandardHours {
        numerator: (i64::from(terms.weekly_minutes?) + i64::from(terms.weekly_paid_minutes?)) * 365,
        denominator: 7 * 12 * 60,
    })
}

#[cfg(test)]
mod tests;

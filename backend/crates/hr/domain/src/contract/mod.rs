//! G1 contract history: the kinds, the terms this MVP types (근기법 §17①:
//! period, wage + unit, 소정근로시간), and the fold from append-only rows to
//! the live history. Pure.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;
use uuid::Uuid;

use crate::profile::enums::PayUnit;

/// 계약 종류 (prototype `CONTRACT_KINDS` plus 일용).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContractKind {
    OpenEnded,
    FixedTerm,
    PartTime,
    Daily,
    DispatchOutsourcing,
    ExecutiveMandate,
    FreelanceService,
}

impl ContractKind {
    pub const ALL: [Self; 7] = [
        Self::OpenEnded,
        Self::FixedTerm,
        Self::PartTime,
        Self::Daily,
        Self::DispatchOutsourcing,
        Self::ExecutiveMandate,
        Self::FreelanceService,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenEnded => "OPEN_ENDED",
            Self::FixedTerm => "FIXED_TERM",
            Self::PartTime => "PART_TIME",
            Self::Daily => "DAILY",
            Self::DispatchOutsourcing => "DISPATCH_OUTSOURCING",
            Self::ExecutiveMandate => "EXECUTIVE_MANDATE",
            Self::FreelanceService => "FREELANCE_SERVICE",
        }
    }

    /// # Errors
    /// Validation when `value` is not a contract kind code.
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| KernelError::validation("kind is not a known contract kind"))
    }

    /// Kinds that must state an end date (parity G2). 기간제: 기간제법 §4 and
    /// 근기법 §17. 파견: 파견법 §20① puts the 근로자파견기간 in the written
    /// contract and §6 caps it. 프리랜서 용역: no statute; the prototype's G2
    /// rule. Domain-only: 0256's `employee_contracts_fixed_term_end` CHECK
    /// stays FIXED_TERM-only (frozen migration) and this crate is the one writer.
    #[must_use]
    pub const fn requires_end_date(self) -> bool {
        matches!(
            self,
            Self::FixedTerm | Self::DispatchOutsourcing | Self::FreelanceService
        )
    }

    /// A 근로계약 (근기법 §17 applies): it must state 소정근로시간 and a wage.
    #[must_use]
    pub const fn is_labour_contract(self) -> bool {
        matches!(
            self,
            Self::OpenEnded | Self::FixedTerm | Self::PartTime | Self::Daily
        )
    }
}

/// The terms a contract row records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractTerms {
    pub kind: ContractKind,
    pub start_date: Date,
    pub end_date: Option<Date>,
    pub wage_won: i64,
    pub pay_unit: PayUnit,
    pub weekly_minutes: Option<i32>,
}

/// Minutes in a week: a physical bound, not a legal one (the legal 소정근로
/// limits are register facts and are checked where they apply).
const WEEK_MINUTES: i32 = 7 * 24 * 60;

/// # Errors
/// Validation naming the first broken term.
pub fn validate_terms(terms: &ContractTerms) -> Result<(), KernelError> {
    let refuse = |message: &str| Err(KernelError::validation(message.to_owned()));
    match (terms.kind, terms.end_date) {
        (kind, None) if kind.requires_end_date() => {
            return refuse(&format!("end_date is required for {}", kind.as_str()));
        }
        (ContractKind::OpenEnded, Some(_)) => {
            return refuse("end_date must be empty for OPEN_ENDED");
        }
        (_, Some(end)) if end < terms.start_date => {
            return refuse("end_date must be on or after start_date");
        }
        _ => {}
    }
    if terms.wage_won < 0 {
        return refuse("wage_won must be a whole number of won, 0 or more");
    }
    if terms.kind.is_labour_contract() {
        if terms.wage_won == 0 {
            return refuse("wage_won is required for a labour contract");
        }
        match terms.weekly_minutes {
            None => return refuse("weekly_minutes is required for a labour contract"),
            Some(minutes) if minutes <= 0 || minutes > WEEK_MINUTES => {
                return refuse("weekly_minutes must be between 1 and 10080");
            }
            Some(_) => {}
        }
    } else if terms
        .weekly_minutes
        .is_some_and(|minutes| minutes <= 0 || minutes > WEEK_MINUTES)
    {
        return refuse("weekly_minutes must be between 1 and 10080");
    }
    Ok(())
}

/// One stored row, as the fold needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractRow {
    pub id: Uuid,
    pub supersedes_id: Option<Uuid>,
    pub terms: ContractTerms,
}

/// Rows no later row supersedes: the live history, newest start first.
#[must_use]
pub fn live_history(rows: &[ContractRow]) -> Vec<&ContractRow> {
    let mut live: Vec<&ContractRow> = rows
        .iter()
        .filter(|row| !rows.iter().any(|later| later.supersedes_id == Some(row.id)))
        .collect();
    live.sort_by_key(|row| std::cmp::Reverse(row.terms.start_date));
    live
}

/// The first live row whose period overlaps `terms`, ignoring the row
/// `terms` supersedes (a correction replaces it). Two live contracts never
/// cover the same day: a renewal starts after the previous end.
#[must_use]
pub fn overlapping<'a>(
    rows: &'a [ContractRow],
    terms: &ContractTerms,
    supersedes_id: Option<Uuid>,
) -> Option<&'a ContractRow> {
    let ends_before = |end: Option<Date>, start: Date| end.is_some_and(|end| end < start);
    live_history(rows).into_iter().find(|row| {
        Some(row.id) != supersedes_id
            && !ends_before(row.terms.end_date, terms.start_date)
            && !ends_before(terms.end_date, row.terms.start_date)
    })
}

/// The live contract covering `day`, if any (latest start wins).
#[must_use]
pub fn in_force(rows: &[ContractRow], day: Date) -> Option<&ContractRow> {
    live_history(rows)
        .into_iter()
        .find(|row| row.terms.start_date <= day && row.terms.end_date.is_none_or(|end| day <= end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn terms(kind: ContractKind, end: Option<Date>) -> ContractTerms {
        ContractTerms {
            kind,
            start_date: date!(2026 - 01 - 01),
            end_date: end,
            wage_won: 2_500_000,
            pay_unit: PayUnit::Monthly,
            weekly_minutes: Some(2400),
        }
    }

    #[test]
    fn period_rules_per_kind() {
        assert!(validate_terms(&terms(ContractKind::OpenEnded, None)).is_ok());
        assert!(
            validate_terms(&terms(ContractKind::OpenEnded, Some(date!(2026 - 12 - 31)))).is_err()
        );
        assert!(validate_terms(&terms(ContractKind::FixedTerm, None)).is_err());
        assert!(
            validate_terms(&terms(ContractKind::FixedTerm, Some(date!(2026 - 12 - 31)))).is_ok()
        );
        assert!(
            validate_terms(&terms(ContractKind::FixedTerm, Some(date!(2025 - 12 - 31)))).is_err()
        );
        for kind in [
            ContractKind::DispatchOutsourcing,
            ContractKind::FreelanceService,
        ] {
            assert!(validate_terms(&terms(kind, None)).is_err(), "{kind:?}");
            assert!(validate_terms(&terms(kind, Some(date!(2026 - 12 - 31)))).is_ok());
        }
        assert!(validate_terms(&terms(ContractKind::ExecutiveMandate, None)).is_ok());
    }

    #[test]
    fn labour_contracts_need_hours_and_a_wage_others_do_not() {
        let mut daily = terms(ContractKind::Daily, None);
        daily.weekly_minutes = None;
        assert!(validate_terms(&daily).is_err());
        daily.weekly_minutes = Some(10_081);
        assert!(validate_terms(&daily).is_err());
        let mut unpaid = terms(ContractKind::PartTime, None);
        unpaid.wage_won = 0;
        assert!(validate_terms(&unpaid).is_err());
        let mut mandate = terms(ContractKind::ExecutiveMandate, None);
        mandate.weekly_minutes = None;
        mandate.wage_won = 0;
        assert!(validate_terms(&mandate).is_ok());
        mandate.wage_won = -1;
        assert!(validate_terms(&mandate).is_err());
    }

    #[test]
    fn superseded_rows_leave_the_history_and_in_force_picks_the_covering_row() {
        let first = ContractRow {
            id: Uuid::from_u128(1),
            supersedes_id: None,
            terms: terms(ContractKind::FixedTerm, Some(date!(2026 - 06 - 30))),
        };
        let fixed = ContractRow {
            id: Uuid::from_u128(2),
            supersedes_id: Some(first.id),
            terms: terms(ContractKind::FixedTerm, Some(date!(2026 - 12 - 31))),
        };
        let mut renewal = terms(ContractKind::OpenEnded, None);
        renewal.start_date = date!(2027 - 01 - 01);
        let open = ContractRow {
            id: Uuid::from_u128(3),
            supersedes_id: None,
            terms: renewal,
        };
        let rows = vec![first, fixed.clone(), open.clone()];
        let ids: Vec<_> = live_history(&rows).iter().map(|row| row.id).collect();
        assert_eq!(ids, [open.id, fixed.id]);
        assert_eq!(
            in_force(&rows, date!(2026 - 09 - 01)).map(|row| row.id),
            Some(fixed.id)
        );
        assert_eq!(
            in_force(&rows, date!(2027 - 03 - 01)).map(|row| row.id),
            Some(open.id)
        );
        assert!(in_force(&rows, date!(2025 - 12 - 31)).is_none());
    }

    #[test]
    fn overlap_ignores_the_corrected_row_and_allows_a_following_renewal() {
        let first = ContractRow {
            id: Uuid::from_u128(1),
            supersedes_id: None,
            terms: terms(ContractKind::FixedTerm, Some(date!(2026 - 06 - 30))),
        };
        let rows = vec![first.clone()];
        let correction = terms(ContractKind::FixedTerm, Some(date!(2026 - 07 - 31)));
        assert_eq!(
            overlapping(&rows, &correction, None).map(|r| r.id),
            Some(first.id)
        );
        assert!(overlapping(&rows, &correction, Some(first.id)).is_none());
        let mut renewal = terms(ContractKind::FixedTerm, Some(date!(2026 - 12 - 31)));
        renewal.start_date = date!(2026 - 07 - 01);
        assert!(overlapping(&rows, &renewal, None).is_none());
        renewal.start_date = date!(2026 - 06 - 30);
        assert!(overlapping(&rows, &renewal, None).is_some());
    }
}

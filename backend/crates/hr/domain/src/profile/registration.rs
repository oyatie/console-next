//! EMP-CREATE: the rules a registration (`POST /api/v1/employees`) applies to
//! the EMP-MODEL facts given with it, and the 최저임금 hint. Pure: the
//! statutory floors arrive from the caller (payroll's register).

use console_kernel_core::KernelError;

use crate::contract::ContractKind;
use crate::profile::enums::{EmploymentType, PayUnit, WorkerClassification};

/// 1주 법정근로시간 40시간 (근로기준법 제50조①), in minutes. The 209-hour
/// monthly floor of the 최저임금 고시 is computed on this week.
const STATUTORY_WEEK_MINUTES: i64 = 40 * 60;
/// 1주 소정근로시간 15시간 미만은 주휴(제55조)가 없다 (근로기준법 제18조③).
/// Below it the 209-hour proportion does not hold, so no monthly floor is
/// derived (the hint stays silent rather than guess).
const WEEKLY_REST_THRESHOLD_MINUTES: i64 = 15 * 60;

/// The contract kinds an initial contract may take for an employment type.
#[must_use]
pub const fn contract_kinds(employment_type: EmploymentType) -> &'static [ContractKind] {
    use ContractKind as K;
    match employment_type {
        EmploymentType::Regular => &[K::OpenEnded],
        EmploymentType::Contract => &[K::FixedTerm],
        EmploymentType::PartTime => &[K::PartTime],
        EmploymentType::Intern => &[K::FixedTerm, K::OpenEnded],
        EmploymentType::Daily => &[K::Daily],
        EmploymentType::Executive => &[K::ExecutiveMandate],
        EmploymentType::DispatchedIn | EmploymentType::OutsourcedOnSite => {
            &[K::DispatchOutsourcing]
        }
        EmploymentType::Freelance => &[K::FreelanceService],
    }
}

/// # Errors
/// Validation when the contract kind does not fit the employment type.
pub fn check_contract_kind(
    employment_type: EmploymentType,
    kind: ContractKind,
) -> Result<(), KernelError> {
    if contract_kinds(employment_type).contains(&kind) {
        Ok(())
    } else {
        Err(KernelError::validation(
            "contract.kind does not fit employment_type",
        ))
    }
}

/// 수습 is a 근로자 fact: 임원, 파견·도급 인력 and 프리랜서 have none.
///
/// # Errors
/// Validation when a probation is given for a non-employee type.
pub fn check_probation_applies(employment_type: EmploymentType) -> Result<(), KernelError> {
    if employment_type.worker_classification() == WorkerClassification::Employee {
        Ok(())
    } else {
        Err(KernelError::validation(
            "probation_end_date applies only to employees",
        ))
    }
}

/// The 최저임금 figures in force on a day (최저임금 고시).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MinimumWageFloors {
    pub hourly_won: i64,
    pub daily_8h_won: i64,
    pub monthly_209h_won: i64,
}

/// The floor a wage in `unit` is compared with, or `None` when it cannot be
/// derived without guessing (a monthly or annual wage under 15 hours a week).
/// A part-time week takes the 209-hour floor in proportion to its 소정근로시간;
/// hours above 40 are overtime and do not raise the base floor.
#[must_use]
pub fn minimum_wage_floor(
    floors: MinimumWageFloors,
    unit: PayUnit,
    weekly_minutes: Option<i32>,
) -> Option<i64> {
    let week = weekly_minutes.map_or(STATUTORY_WEEK_MINUTES, i64::from);
    let monthly = || {
        (week >= WEEKLY_REST_THRESHOLD_MINUTES).then(|| {
            floors.monthly_209h_won * week.min(STATUTORY_WEEK_MINUTES) / STATUTORY_WEEK_MINUTES
        })
    };
    match unit {
        PayUnit::Hourly => Some(floors.hourly_won),
        PayUnit::Daily => Some(floors.daily_8h_won),
        PayUnit::Monthly => monthly(),
        PayUnit::Annual => monthly().map(|floor| floor * 12),
    }
}

/// True when a 근로자's wage is below its floor. Non-employees (임원, 파견·도급,
/// 프리랜서) are outside the 최저임금법 for this tenant and never warn.
#[must_use]
pub fn below_minimum_wage(
    employment_type: EmploymentType,
    wage_won: i64,
    floor_won: Option<i64>,
) -> bool {
    employment_type.worker_classification() == WorkerClassification::Employee
        && floor_won.is_some_and(|floor| wage_won < floor)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOORS: MinimumWageFloors = MinimumWageFloors {
        hourly_won: 10_320,
        daily_8h_won: 82_560,
        monthly_209h_won: 2_156_880,
    };

    #[test]
    fn every_type_has_a_kind_and_mismatches_are_refused() {
        for kind in EmploymentType::ALL {
            assert!(!contract_kinds(*kind).is_empty(), "{kind:?}");
        }
        assert!(check_contract_kind(EmploymentType::Contract, ContractKind::FixedTerm).is_ok());
        assert!(check_contract_kind(EmploymentType::Regular, ContractKind::FixedTerm).is_err());
        assert!(
            check_contract_kind(EmploymentType::Freelance, ContractKind::FreelanceService).is_ok()
        );
        assert!(check_contract_kind(EmploymentType::Executive, ContractKind::OpenEnded).is_err());
    }

    #[test]
    fn probation_only_for_employees() {
        assert!(check_probation_applies(EmploymentType::Daily).is_ok());
        assert!(check_probation_applies(EmploymentType::Executive).is_err());
        assert!(check_probation_applies(EmploymentType::Freelance).is_err());
    }

    #[test]
    fn floors_per_unit_and_week() {
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Hourly, None),
            Some(10_320)
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Daily, None),
            Some(82_560)
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Monthly, None),
            Some(2_156_880)
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Monthly, Some(2400)),
            Some(2_156_880)
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Monthly, Some(3000)),
            Some(2_156_880)
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Monthly, Some(1200)),
            Some(1_078_440)
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Monthly, Some(899)),
            None
        );
        assert_eq!(
            minimum_wage_floor(FLOORS, PayUnit::Annual, None),
            Some(25_882_560)
        );
    }

    #[test]
    fn only_employees_below_the_floor_warn() {
        assert!(below_minimum_wage(
            EmploymentType::Regular,
            2_000_000,
            Some(2_156_880)
        ));
        assert!(!below_minimum_wage(
            EmploymentType::Regular,
            2_156_880,
            Some(2_156_880)
        ));
        assert!(!below_minimum_wage(
            EmploymentType::Executive,
            1,
            Some(2_156_880)
        ));
        assert!(!below_minimum_wage(EmploymentType::PartTime, 1, None));
    }
}

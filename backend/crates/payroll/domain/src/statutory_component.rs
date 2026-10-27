// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    ContributionBasis, ShareRule, StatutoryComponent, StatutoryRate, checked_i128_to_i64,
    checked_mul_i128, health_premium_band_on, rounding_unit_label,
};
use console_kernel_core::KernelError;
use time::Date;

pub(crate) fn statutory_component(
    day: Date,
    rate: StatutoryRate,
    label_ko: &'static str,
    basis_won: Option<i64>,
) -> Result<StatutoryComponent, KernelError> {
    let code = rate.code;
    let rate_is_ingested = rate.basis != ContributionBasis::IndustryTariff;
    let mut blocked_by: Option<&'static str> = None;
    let total_won = match basis_won {
        None => None,
        Some(basis_won) => {
            let raw = checked_mul_i128(basis_won, rate.rate_num)? / i128::from(rate.rate_den);
            match rate.total_rounding.apply(raw) {
                Ok(rounded) if rate.clamp_required => match health_premium_band_on(day) {
                    Ok(band) => Some(checked_i128_to_i64(
                        rounded.clamp(i128::from(band.floor_won), i128::from(band.cap_won)),
                    )?),
                    Err(_) => {
                        blocked_by = Some("HEALTH_PREMIUM_BAND_MISSING");
                        None
                    }
                },
                Ok(rounded) => Some(checked_i128_to_i64(rounded)?),
                Err(question_id) => {
                    blocked_by = Some(question_id);
                    None
                }
            }
        }
    };

    let employer_only = matches!(rate.employee_share, ShareRule::EmployerOnly);
    let employee_won = match (total_won, rate.employee_share) {
        (_, ShareRule::EmployerOnly) => None,
        (Some(total), ShareRule::WholeOfRate) => Some(total),
        (Some(total), ShareRule::Half { rounding }) => {
            match rounding.apply(i128::from(total) * 50 / 100) {
                Ok(share) => Some(checked_i128_to_i64(share)?),
                Err(question_id) => {
                    blocked_by = Some(question_id);
                    None
                }
            }
        }
        (None, _) => None,
    };

    Ok(StatutoryComponent {
        code,
        label_ko,
        basis: rate.basis,
        basis_won,
        rate_num: rate_is_ingested.then_some(rate.rate_num),
        rate_den: rate_is_ingested.then_some(rate.rate_den),
        total_won,
        employee_won,
        employer_only,
        blocked_by,
        total_rounding_unit: rounding_unit_label(rate.total_rounding),
        employee_rounding_unit: match rate.employee_share {
            ShareRule::Half { rounding } => rounding_unit_label(rounding),
            ShareRule::WholeOfRate => rounding_unit_label(rate.total_rounding),
            ShareRule::EmployerOnly => "NOT_APPLICABLE",
        },
        instrument: rate.instrument,
        share_instrument: rate.share_instrument,
        provenance: rate.provenance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ContributionCode, StatutoryInsuranceInput, build_statutory_insurance_draft,
        contribution_rate_on, minimum_wage_on,
    };
    use time::macros::date;

    #[test]
    fn january_2027_uses_new_rates_and_blocks_the_health_line_without_a_dated_band() {
        let day = date!(2027 - 01 - 10);
        let pension = contribution_rate_on(ContributionCode::NationalPension, day).unwrap();
        assert_eq!((pension.rate_num, pension.rate_den), (500, 10_000));
        let health = contribution_rate_on(ContributionCode::HealthInsurance, day).unwrap();
        assert_eq!((health.rate_num, health.rate_den), (719, 10_000));
        let line = statutory_component(day, health, "건강보험", Some(3_000_000)).unwrap();
        assert_eq!(line.blocked_by, Some("HEALTH_PREMIUM_BAND_MISSING"));
        assert_eq!((line.total_won, line.employee_won), (None, None));
        assert_eq!(minimum_wage_on(day).unwrap().hourly_won, 10_700);
        let error = build_statutory_insurance_draft(&StatutoryInsuranceInput {
            pay_date: day,
            monthly_remuneration_won: 3_000_000,
            pension_standard_monthly_income_won: None,
            monthly_standard_hours: Some(209),
        })
        .unwrap_err();
        assert_eq!(
            error.message,
            "missing payroll rate LongTermCare for 2027-01-10"
        );
    }

    #[test]
    fn band_boundaries_fail_closed_and_the_2026_floor_is_preserved() {
        assert!(health_premium_band_on(date!(2025 - 12 - 31)).is_err());
        assert!(health_premium_band_on(date!(2026 - 01 - 01)).is_ok());
        assert!(health_premium_band_on(date!(2026 - 12 - 31)).is_ok());
        assert_eq!(
            health_premium_band_on(date!(2027 - 01 - 01))
                .unwrap_err()
                .message,
            "HEALTH_PREMIUM_BAND_MISSING: 2027-01-01"
        );
        let health =
            contribution_rate_on(ContributionCode::HealthInsurance, date!(2026 - 12 - 31)).unwrap();
        let line =
            statutory_component(date!(2026 - 12 - 31), health, "건강보험", Some(200_000)).unwrap();
        assert_eq!(line.total_won, Some(20_160));
        assert_eq!(line.blocked_by, None);
    }
}

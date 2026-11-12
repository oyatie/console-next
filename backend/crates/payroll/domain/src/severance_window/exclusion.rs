//! Enforcement Decree of the Labor Standards Act §2①: the eight classes of
//! period removed from the average-wage window, and the span each one actually
//! removes.
//!
//! §2② (wages and allowances paid temporarily, wages paid other than in
//! currency) shapes the wage total, not the days; it belongs to whoever sums
//! the wages.

use console_kernel_core::KernelError;
use time::Date;

/// Why a span leaves the window: exactly the items of Decree §2①, nothing else.
/// A suspension of work that is neither attributable to the employer (item 2)
/// nor approved by the employer (item 8) has no variant, so it can never be
/// excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExclusionReason {
    /// Item 1: probation — only the 3 months from the day probation started.
    Probation,
    /// Item 2: Act §46, a period of work suspension for a reason attributable
    /// to the employer.
    EmployerFaultShutdown,
    /// Item 3: Act §74①–③, maternity leave before and after childbirth, and
    /// miscarriage or stillbirth leave.
    MaternityLeave,
    /// Item 4: Act §78, time off for medical care of an occupational injury or
    /// illness.
    OccupationalInjuryLeave,
    /// Item 5: Equal Employment Opportunity Act §19, childcare leave.
    ChildcareLeave,
    /// Item 6: Trade Union Act §2(6), a period of industrial action.
    IndustrialAction,
    /// Item 7: leave or absence to perform a duty under the Military Service
    /// Act, the Reserve Forces Act or the Framework Act on Civil Defense.
    /// Proviso: not excluded when wages were paid for it.
    MilitaryDuty { paid: bool },
    /// Item 8: a period off work, with the employer's approval, for a
    /// non-occupational injury or illness or another reason.
    ApprovedLeave,
}

impl ExclusionReason {
    /// The Decree §2① item this class is, for the audit trail.
    #[must_use]
    pub const fn decree_item(self) -> u8 {
        match self {
            Self::Probation => 1,
            Self::EmployerFaultShutdown => 2,
            Self::MaternityLeave => 3,
            Self::OccupationalInjuryLeave => 4,
            Self::ChildcareLeave => 5,
            Self::IndustrialAction => 6,
            Self::MilitaryDuty { .. } => 7,
            Self::ApprovedLeave => 8,
        }
    }
}

/// A recorded span, both ends inclusive. For [`ExclusionReason::Probation`]
/// `from` must be the day probation started, not a date clipped to the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExclusionPeriod {
    pub from: Date,
    pub to: Date,
    pub reason: ExclusionReason,
}

impl ExclusionPeriod {
    /// The part Decree §2① removes, before clipping to the window; `None` when
    /// the class removes nothing (item 7 proviso: paid).
    pub(super) fn statutory_span(&self) -> Result<Option<(Date, Date)>, KernelError> {
        if self.to < self.from {
            return Err(KernelError::validation(
                "exclusion period end must be on or after its start",
            ));
        }
        let to = match self.reason {
            ExclusionReason::MilitaryDuty { paid: true } => return Ok(None),
            ExclusionReason::Probation => self.to.min(probation_last_day(self.from)?),
            _ => self.to,
        };
        Ok(Some((self.from, to)))
    }
}

/// Last day of "within 3 months from the day probation started": the day before the
/// corresponding day 3 months on, or that month's last day when there is
/// none (Civil Act §160②③: 11/30 → 2/28).
fn probation_last_day(start: Date) -> Result<Date, KernelError> {
    super::months_before(start, -3)?
        .previous_day()
        .ok_or_else(|| KernelError::validation("date is out of range"))
}

#[cfg(test)]
mod tests {
    use super::super::average_wage_window;
    use super::*;
    use time::macros::date;

    fn period(from: Date, to: Date, reason: ExclusionReason) -> ExclusionPeriod {
        ExclusionPeriod { from, to, reason }
    }

    #[test]
    fn decree_has_exactly_eight_classes() {
        // Decree §2① items 1–8; the paid flag does not change the class.
        let items: Vec<u8> = [
            ExclusionReason::Probation,
            ExclusionReason::EmployerFaultShutdown,
            ExclusionReason::MaternityLeave,
            ExclusionReason::OccupationalInjuryLeave,
            ExclusionReason::ChildcareLeave,
            ExclusionReason::IndustrialAction,
            ExclusionReason::MilitaryDuty { paid: false },
            ExclusionReason::ApprovedLeave,
        ]
        .map(ExclusionReason::decree_item)
        .to_vec();
        assert_eq!(items, (1..=8).collect::<Vec<u8>>());
    }

    #[test]
    fn probation_counts_only_its_first_three_months() {
        // Decree §2①1: probation 6/15–10/31 removes 6/15–9/14; in the 7/1–9/30
        // window that is 7/1–9/14 = 76 days, leaving 16.
        let p = period(
            date!(2026 - 06 - 15),
            date!(2026 - 10 - 31),
            ExclusionReason::Probation,
        );
        assert_eq!(
            p.statutory_span().unwrap(),
            Some((date!(2026 - 06 - 15), date!(2026 - 09 - 14)))
        );
        let w = average_wage_window(date!(2026 - 09 - 30), &[p]).unwrap();
        assert_eq!((w.excluded_days, w.countable_days), (76, 16));
    }

    #[test]
    fn probation_cap_uses_month_end_without_a_corresponding_day() {
        // Decree §2①1 with Civil Act §160③: started 11/30 → last excluded day 2/28.
        let p = period(
            date!(2025 - 11 - 30),
            date!(2026 - 05 - 31),
            ExclusionReason::Probation,
        );
        assert_eq!(
            p.statutory_span().unwrap(),
            Some((date!(2025 - 11 - 30), date!(2026 - 02 - 28)))
        );
    }

    #[test]
    fn paid_military_duty_is_not_excluded() {
        // Decree §2①7 proviso: "This shall not apply where wages were paid
        // during that period."
        let exit = date!(2026 - 09 - 30);
        let duty = |paid| {
            period(
                date!(2026 - 08 - 01),
                date!(2026 - 08 - 10),
                ExclusionReason::MilitaryDuty { paid },
            )
        };
        let paid = average_wage_window(exit, &[duty(true)]).unwrap();
        assert_eq!(paid.excluded_days, 0);
        let unpaid = average_wage_window(exit, &[duty(false)]).unwrap();
        assert_eq!(unpaid.excluded_days, 10);
    }

    #[test]
    fn other_classes_remove_the_whole_recorded_span() {
        // Decree §2①2–6, 8: no cap; only the window clips them.
        for reason in [
            ExclusionReason::EmployerFaultShutdown,
            ExclusionReason::MaternityLeave,
            ExclusionReason::OccupationalInjuryLeave,
            ExclusionReason::ChildcareLeave,
            ExclusionReason::IndustrialAction,
            ExclusionReason::ApprovedLeave,
        ] {
            let p = period(date!(2026 - 01 - 01), date!(2026 - 12 - 31), reason);
            assert_eq!(
                p.statutory_span().unwrap(),
                Some((date!(2026 - 01 - 01), date!(2026 - 12 - 31)))
            );
        }
    }
}

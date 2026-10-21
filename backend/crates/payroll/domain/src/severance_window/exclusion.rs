//! 근로기준법 시행령 §2①: the eight classes of period removed from the
//! average-wage window, and the span each one actually removes.
//!
//! §2② (임시로 지급된 임금·수당, 통화 외 임금) shapes the wage total, not the
//! days; it belongs to whoever sums the wages.

use console_kernel_core::KernelError;
use time::Date;

/// Why a span leaves the window: exactly the 영 §2① 각 호, nothing else.
/// A 휴업 that is neither 사용자 귀책 (2호) nor approved by the employer
/// (8호) has no variant, so it can never be excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExclusionReason {
    /// 1호: 수습 — only the 3 months from the day 수습 started.
    Probation,
    /// 2호: 법 §46 사용자의 귀책사유로 휴업한 기간.
    EmployerFaultShutdown,
    /// 3호: 법 §74①–③ 출산전후휴가 및 유산·사산 휴가.
    MaternityLeave,
    /// 4호: 법 §78 업무상 부상·질병 요양 휴업.
    OccupationalInjuryLeave,
    /// 5호: 남녀고용평등법 §19 육아휴직.
    ChildcareLeave,
    /// 6호: 노동조합법 §2(6) 쟁의행위기간.
    IndustrialAction,
    /// 7호: 병역법·예비군법·민방위기본법 의무 이행 휴직·결근.
    /// 단서: not excluded when wages were paid for it.
    MilitaryDuty { paid: bool },
    /// 8호: 업무 외 부상·질병, 그 밖의 사유로 사용자의 승인을 받아 휴업한 기간.
    ApprovedLeave,
}

impl ExclusionReason {
    /// The 영 §2① 호 this class is, for the audit trail.
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
/// `from` must be the day 수습 started, not a date clipped to the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExclusionPeriod {
    pub from: Date,
    pub to: Date,
    pub reason: ExclusionReason,
}

impl ExclusionPeriod {
    /// The part 영 §2① removes, before clipping to the window; `None` when
    /// the class removes nothing (7호 단서: paid).
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

/// Last day of 「수습을 시작한 날부터 3개월 이내」: the day before the
/// corresponding day 3 months on, or that month's last day when there is
/// none (민법 §160②③: 11/30 → 2/28).
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
        // 영 §2① 1호–8호; the paid flag does not change the class.
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
        // 영 §2①1: 수습 6/15–10/31 removes 6/15–9/14; in the 7/1–9/30
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
        // 영 §2①1 with 민법 §160③: started 11/30 → last excluded day 2/28.
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
        // 영 §2①7 단서: 그 기간 중 임금을 지급받은 경우에는 그러하지 아니하다.
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
        // 영 §2①2–6, 8: no cap; only the window clips them.
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

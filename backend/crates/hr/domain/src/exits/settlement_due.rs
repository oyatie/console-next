//! What the leaving employer owes in money, and by when (the EXIT template's
//! X6 and X7 rows): every 금품 (「근로기준법」 제36조) and the 퇴직금
//! (「근로자퇴직급여 보장법」 제9조). A 전적 that carries 퇴직금 opens no exit
//! case, so every case settles both. The number of days comes from the
//! statutory register; this names the rule only.
//!
//! The window opens on the 퇴직일, the day after the 마지막 근무일, when the
//! 지급 사유 arises: a payment may be made from then. The deadline counts
//! from the 마지막 근무일 as the template does (the earlier date, #9).

use time::Date;

use crate::cases::clocks::{Anchor, Anchors, Clock, DueRegister, DueRule, RuleKind, case_clocks};

/// One payment the leaving employer settles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettlementDue {
    /// 금품청산: final wages, 남은 연차 수당 and every other 금품.
    FinalPay,
    /// 퇴직금 (to the worker's IRP unless an exception applies).
    SeverancePay,
}

impl SettlementDue {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FinalPay => "FINAL_PAY",
            Self::SeverancePay => "SEVERANCE_PAY",
        }
    }

    /// The register row behind the deadline.
    #[must_use]
    pub const fn register_code(self) -> &'static str {
        match self {
            Self::FinalPay => "FINAL_PAY_DUE_DAYS",
            Self::SeverancePay => "SEVERANCE_PAY_DUE_DAYS",
        }
    }

    fn rule(self) -> DueRule {
        DueRule {
            anchor: Some(Anchor::ExitDate),
            kind: RuleKind::DaysAfter,
            register_code: Some(self.register_code().to_owned()),
        }
    }
}

/// One payment's window: open from `opens_on`, due by the clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementWindow {
    pub due: SettlementDue,
    pub opens_on: Option<Date>,
    pub clock: Clock,
}

/// The payments an exit on `exit_date` (the 마지막 근무일) settles.
#[must_use]
pub fn settlement_windows(exit_date: Date, register: &dyn DueRegister) -> Vec<SettlementWindow> {
    let dues = [SettlementDue::FinalPay, SettlementDue::SeverancePay];
    let rules: Vec<DueRule> = dues.iter().map(|d| d.rule()).collect();
    let anchors = Anchors([(Anchor::ExitDate, exit_date)].into_iter().collect());
    dues.iter()
        .zip(case_clocks(&rules, &anchors, register))
        .map(|(&due, clock)| SettlementWindow {
            due,
            opens_on: exit_date.next_day(),
            clock,
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::cases::clocks::{RegisterUnit, RegisterValue};
    use console_kernel_core::KernelError;
    use time::macros::date;

    struct Rows(u16, u16);
    impl DueRegister for Rows {
        fn value(&self, code: &str, _on: Date) -> Result<RegisterValue, KernelError> {
            let value = match code {
                "FINAL_PAY_DUE_DAYS" => self.0,
                "SEVERANCE_PAY_DUE_DAYS" => self.1,
                _ => return Err(KernelError::validation("no row")),
            };
            Ok(RegisterValue {
                unit: RegisterUnit::Days,
                value,
                held: value == 0,
            })
        }
    }

    #[test]
    fn the_register_sets_each_deadline_and_the_window_opens_on_the_exit_day() {
        let w = settlement_windows(date!(2026 - 10 - 31), &Rows(14, 10));
        assert_eq!(w.len(), 2);
        assert_eq!(
            w.iter().map(|x| x.due.as_str()).collect::<Vec<_>>(),
            ["FINAL_PAY", "SEVERANCE_PAY"]
        );
        assert_eq!(w[0].due, SettlementDue::FinalPay);
        assert_eq!(w[0].opens_on, Some(date!(2026 - 11 - 01)));
        assert_eq!(
            w[0].clock,
            Clock::Due {
                date: date!(2026 - 11 - 14),
                held: false
            }
        );
        assert_eq!(w[1].due, SettlementDue::SeverancePay);
        assert_eq!(
            w[1].clock,
            Clock::Due {
                date: date!(2026 - 11 - 10),
                held: false
            }
        );
    }

    #[test]
    fn a_missing_register_row_is_unresolved_never_a_guessed_date() {
        struct Empty;
        impl DueRegister for Empty {
            fn value(&self, _: &str, _: Date) -> Result<RegisterValue, KernelError> {
                Err(KernelError::validation("no row"))
            }
        }
        let w = settlement_windows(date!(2026 - 10 - 31), &Empty);
        assert!(w.iter().all(|x| matches!(x.clock, Clock::Unresolved(_))));
    }
}

//! `case_clocks`: the due date of every case item, generalising
//! [`crate::exits::clocks::exit_clocks`] (lifecycle-events.md §5.3).
//!
//! A due rule is `{anchor, kind, register code}`. The number always comes from
//! the statutory register through [`DueRegister`] (no day count lives here);
//! the register answers SF's `ins.deadline.*` keys too. Pure: the caller loads
//! the register and passes the anchors. Where the law says 「지체 없이」 the
//! clock is [`Clock::WithoutDelay`]; where the deadline was not verified it is
//! [`Clock::Unknown`] (「기한 미확인」) — never a guessed date.

use std::collections::BTreeMap;

use console_kernel_core::KernelError;
use time::{Date, Duration};

use crate::exits::clocks::add_months;

/// The date a rule counts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Anchor {
    EffectiveDate,
    /// 마지막 근무일 (#9).
    ExitDate,
    /// 상실일 = the day after the exit date.
    LossDate,
    StartDate,
    RequestDate,
    RegistrationDate,
    PaymentDate,
    TwoYearDate,
    ExpectedReturn,
}

impl Anchor {
    const NAMES: [(Self, &'static str); 9] = [
        (Self::EffectiveDate, "EFFECTIVE_DATE"),
        (Self::ExitDate, "EXIT_DATE"),
        (Self::LossDate, "LOSS_DATE"),
        (Self::StartDate, "START_DATE"),
        (Self::RequestDate, "REQUEST_DATE"),
        (Self::RegistrationDate, "REGISTRATION_DATE"),
        (Self::PaymentDate, "PAYMENT_DATE"),
        (Self::TwoYearDate, "TWO_YEAR_DATE"),
        (Self::ExpectedReturn, "EXPECTED_RETURN"),
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        Self::NAMES
            .iter()
            .find(|(anchor, _)| *anchor == self)
            .map_or("", |(_, name)| name)
    }

    /// # Errors
    /// Validation for a name outside the set.
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        Self::NAMES
            .iter()
            .find(|(_, name)| *name == value)
            .map(|(anchor, _)| *anchor)
            .ok_or_else(|| KernelError::validation("lifecycle_due_anchor_unknown"))
    }
}

/// How a rule turns its anchor and number into a date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    DaysAfter,
    DayOfNextMonth,
    MonthsAfter,
    DaysBefore,
    EndOfNextMonth,
    Immediate,
    WithoutDelay,
    Unknown,
}

impl RuleKind {
    /// # Errors
    /// Validation for a name outside the set.
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        Ok(match value {
            "DAYS_AFTER" => Self::DaysAfter,
            "DAY_OF_NEXT_MONTH" => Self::DayOfNextMonth,
            "MONTHS_AFTER" => Self::MonthsAfter,
            "DAYS_BEFORE" => Self::DaysBefore,
            "END_OF_NEXT_MONTH" => Self::EndOfNextMonth,
            "IMMEDIATE" => Self::Immediate,
            "WITHOUT_DELAY" => Self::WithoutDelay,
            "UNKNOWN" => Self::Unknown,
            _ => return Err(KernelError::validation("lifecycle_due_rule_unknown")),
        })
    }

    /// The kinds whose number comes from the register.
    const fn needs_number(self) -> bool {
        matches!(
            self,
            Self::DaysAfter | Self::DayOfNextMonth | Self::MonthsAfter | Self::DaysBefore
        )
    }
}

/// One item's due rule, as `case_template_items` stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueRule {
    pub anchor: Option<Anchor>,
    pub kind: RuleKind,
    pub register_code: Option<String>,
}

impl DueRule {
    /// The `case_template_items_due_shape` CHECK, in code: UNKNOWN has neither
    /// anchor nor code; a numbered kind has both; the rest an anchor only.
    ///
    /// # Errors
    /// Validation `lifecycle_due_rule_shape` when the parts do not fit.
    pub fn parse(
        anchor: Option<&str>,
        kind: &str,
        code: Option<&str>,
    ) -> Result<Self, KernelError> {
        let kind = RuleKind::parse(kind)?;
        let anchor = anchor.map(Anchor::parse).transpose()?;
        let fits = match kind {
            RuleKind::Unknown => anchor.is_none() && code.is_none(),
            k if k.needs_number() => anchor.is_some() && code.is_some(),
            _ => anchor.is_some() && code.is_none(),
        };
        if !fits {
            return Err(KernelError::validation("lifecycle_due_rule_shape"));
        }
        Ok(Self {
            anchor,
            kind,
            register_code: code.map(str::to_owned),
        })
    }
}

/// The anchor dates known for a case (missing ones leave the clock waiting).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Anchors(pub BTreeMap<Anchor, Date>);

/// What a register number measures, as far as due rules care.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterUnit {
    Days,
    Months,
    DayOfNextMonth,
}

/// A register row's number for a code on a day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegisterValue {
    pub unit: RegisterUnit,
    pub value: u16,
    /// The row is HOLD (not yet released by a qualified reviewer).
    pub held: bool,
}

/// The statutory register as the clocks see it. A missing row is an error,
/// never a default (fail closed).
pub trait DueRegister {
    /// # Errors
    /// No row for `code` in force on `on`, or a row the clocks cannot use.
    fn value(&self, code: &str, on: Date) -> Result<RegisterValue, KernelError>;
    /// Complete statutory clock; legacy numbered rules retain their existing calculation.
    fn filing_clock(&self, _code: &str, _anchors: &Anchors) -> Result<Option<Clock>, KernelError> {
        Ok(None)
    }
}

/// One item's clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Clock {
    /// A due date; `held` when the register row behind it is HOLD.
    Due { date: Date, held: bool },
    /// 「지체 없이」: no date; days are counted from `since`.
    WithoutDelay { since: Date },
    /// 「기한 미확인」.
    Unknown,
    /// The anchor has not happened yet (a request, a payment).
    AwaitingAnchor(Anchor),
    /// The register cannot answer (no row in force, wrong unit, out of range).
    Unresolved(String),
}

/// The clock of every rule, in order.
#[must_use]
pub fn case_clocks(rules: &[DueRule], anchors: &Anchors, register: &dyn DueRegister) -> Vec<Clock> {
    rules
        .iter()
        .map(|rule| {
            clock(rule, anchors, register)
                .unwrap_or_else(|error| Clock::Unresolved(error.to_string()))
        })
        .collect()
}

fn clock(
    rule: &DueRule,
    anchors: &Anchors,
    register: &dyn DueRegister,
) -> Result<Clock, KernelError> {
    if let Some(code) = rule.register_code.as_deref()
        && let Some(clock) = register.filing_clock(code, anchors)?
    {
        return Ok(clock);
    }
    let Some(anchor) = rule.anchor else {
        return Ok(Clock::Unknown);
    };
    let Some(&on) = anchors.0.get(&anchor) else {
        return Ok(Clock::AwaitingAnchor(anchor));
    };
    let number = |unit: RegisterUnit| -> Result<RegisterValue, KernelError> {
        let code = rule.register_code.as_deref().unwrap_or_default();
        let value = register.value(code, on)?;
        if value.unit != unit {
            return Err(KernelError::validation(format!(
                "register row {code} is not in {unit:?}"
            )));
        }
        Ok(value)
    };
    let due = |date: Option<Date>, held: bool| {
        date.map(|date| Clock::Due { date, held }).ok_or_else(|| {
            KernelError::validation("due date is outside the supported calendar range")
        })
    };
    match rule.kind {
        RuleKind::Unknown => Ok(Clock::Unknown),
        RuleKind::WithoutDelay => Ok(Clock::WithoutDelay { since: on }),
        RuleKind::Immediate => due(Some(on), false),
        RuleKind::EndOfNextMonth => {
            let next = add_months(on, 1)?;
            due(
                next.replace_day(next.month().length(next.year())).ok(),
                false,
            )
        }
        RuleKind::DaysAfter => {
            let n = number(RegisterUnit::Days)?;
            due(on.checked_add(Duration::days(n.value.into())), n.held)
        }
        RuleKind::DaysBefore => {
            let n = number(RegisterUnit::Days)?;
            due(on.checked_sub(Duration::days(n.value.into())), n.held)
        }
        RuleKind::MonthsAfter => {
            let n = number(RegisterUnit::Months)?;
            let months = u8::try_from(n.value)
                .map_err(|_| KernelError::validation("month count out of range"))?;
            due(Some(add_months(on, months)?), n.held)
        }
        RuleKind::DayOfNextMonth => {
            let n = number(RegisterUnit::DayOfNextMonth)?;
            let day =
                u8::try_from(n.value).map_err(|_| KernelError::validation("day out of range"))?;
            due(add_months(on, 1)?.replace_day(day).ok(), n.held)
        }
    }
}

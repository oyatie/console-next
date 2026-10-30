//! Statutory register lookup (BW-30).
//!
//! Legal numbers, code tables and clocks live in two global, migration-only
//! tables: `statutory_rules` and `insurance_loss_codes`. The adapter loads the
//! rows; this module validates them as a whole and answers "which row was in
//! force on day D". A missing or ambiguous row is an error, never a default.
//!
//! Rows ship as HOLD until a qualified reviewer lifts them in
//! `console-jurisdiction-register.json`. Lookups still return HOLD rows (the
//! clocks ship under HOLD); callers surface [`ReleaseDisposition`] and record
//! the row they used.

pub mod codes;
pub mod deadline;
pub mod filing;
mod filing_register;
mod loss_codes;
#[cfg(test)]
mod tests;

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;

pub use loss_codes::{InsuranceLossCode, Insurer, LossReasonGroup};

/// The `console-jurisdiction-register.json` control that holds every register
/// row. While it is HOLD, no row may be RELEASED (pinned by the adapter's
/// `statutory_register` test against the committed register).
pub const JURISDICTION_CONTROL_ID: &str = "CTRL-KR-WORKFORCE-001";

/// What a rule's number measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StatutoryUnit {
    Days,
    Months,
    Years,
    /// A day of the month after the triggering event's month.
    DayOfNextMonth,
    HoursPerWeek,
    /// `value_num / value_den` per year.
    AnnualRate,
}

impl StatutoryUnit {
    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        Ok(match value {
            "DAYS" => Self::Days,
            "MONTHS" => Self::Months,
            "YEARS" => Self::Years,
            "DAY_OF_NEXT_MONTH" => Self::DayOfNextMonth,
            "HOURS_PER_WEEK" => Self::HoursPerWeek,
            "ANNUAL_RATE" => Self::AnnualRate,
            other => {
                return Err(KernelError::validation(format!(
                    "unknown statutory unit {other:?}"
                )));
            }
        })
    }
}

/// Whether a qualified reviewer has lifted the row's HOLD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "disposition")]
pub enum ReleaseDisposition {
    Hold,
    /// `receipt_ref` points at the reviewer's receipt in the jurisdiction register.
    Released {
        receipt_ref: String,
    },
}

impl ReleaseDisposition {
    pub fn from_db(disposition: &str, receipt_ref: Option<String>) -> Result<Self, KernelError> {
        match (disposition, receipt_ref) {
            ("HOLD", None) => Ok(Self::Hold),
            ("RELEASED", Some(receipt_ref)) if !receipt_ref.trim().is_empty() => {
                Ok(Self::Released { receipt_ref })
            }
            (other, _) => Err(KernelError::validation(format!(
                "statutory release disposition {other:?} does not match its review receipt"
            ))),
        }
    }

    #[must_use]
    pub const fn is_hold(&self) -> bool {
        matches!(self, Self::Hold)
    }
}

/// The instrument and article that set a number, as shown to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    pub instrument_ko: String,
    pub article_ko: String,
    pub source_url: String,
}

/// One `statutory_rules` row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatutoryRule {
    pub code: String,
    pub effective_from: Date,
    pub effective_to_exclusive: Option<Date>,
    pub unit: StatutoryUnit,
    pub value_num: i64,
    pub value_den: i64,
    pub citation: Citation,
    pub disposition: ReleaseDisposition,
}

impl StatutoryRule {
    /// The number as a whole count of `unit`. Errors when the caller expects a
    /// different unit or the value is fractional, so a misread rule fails loud.
    pub fn whole(&self, unit: StatutoryUnit) -> Result<i64, KernelError> {
        let (num, den) = self.ratio(unit)?;
        if den != 1 {
            return Err(KernelError::validation(format!(
                "statutory rule {} is fractional ({num}/{den})",
                self.code
            )));
        }
        Ok(num)
    }

    /// The number as an exact `(numerator, denominator)` in `unit`.
    pub fn ratio(&self, unit: StatutoryUnit) -> Result<(i64, i64), KernelError> {
        if self.unit != unit {
            return Err(KernelError::validation(format!(
                "statutory rule {} is measured in {:?}, not {unit:?}",
                self.code, self.unit
            )));
        }
        Ok((self.value_num, self.value_den))
    }
}

/// The validated register: no unknown rule codes, no overlapping periods.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatutoryRegister {
    rules: Vec<StatutoryRule>,
    loss_codes: Vec<InsuranceLossCode>,
    filing_rules: Vec<filing::FilingRule>,
}

impl StatutoryRegister {
    /// Validated rule periods, for batched projections of the register's clocks.
    #[must_use]
    pub fn rules(&self) -> &[StatutoryRule] {
        &self.rules
    }

    pub fn new(
        rules: Vec<StatutoryRule>,
        loss_codes: Vec<InsuranceLossCode>,
    ) -> Result<Self, KernelError> {
        for rule in &rules {
            if !codes::ALL.contains(&rule.code.as_str()) {
                return Err(KernelError::validation(format!(
                    "unknown statutory rule code {:?}",
                    rule.code
                )));
            }
            if rule.value_num < 0 || rule.value_den <= 0 {
                return Err(KernelError::validation(format!(
                    "statutory rule {} has an invalid value",
                    rule.code
                )));
            }
        }
        reject_overlaps(rules.iter().map(|r| {
            (
                (r.code.clone(), None),
                r.effective_from,
                r.effective_to_exclusive,
            )
        }))?;
        reject_overlaps(loss_codes.iter().map(|c| {
            (
                (c.code.clone(), Some(c.insurer)),
                c.effective_from,
                c.effective_to_exclusive,
            )
        }))?;
        Ok(Self {
            rules,
            loss_codes,
            filing_rules: Vec::new(),
        })
    }

    /// The rule `code` (or an `ins.deadline.*` alias of one) in force on `on`.
    pub fn rule(&self, code: &str, on: Date) -> Result<&StatutoryRule, KernelError> {
        let code = codes::resolve(code);
        self.rules
            .iter()
            .find(|r| r.code == code && in_force(r.effective_from, r.effective_to_exclusive, on))
            .ok_or_else(|| {
                KernelError::not_found(format!("no statutory rule {code} in force on {on}"))
            })
    }

    /// The `insurer` 상실 code `code` in force on `on`.
    pub fn loss_code(
        &self,
        insurer: Insurer,
        code: &str,
        on: Date,
    ) -> Result<&InsuranceLossCode, KernelError> {
        self.loss_codes_on(insurer, on)
            .find(|c| c.code == code)
            .ok_or_else(|| {
                KernelError::validation(format!(
                    "no {insurer:?} loss code {code:?} in force on {on}"
                ))
            })
    }

    /// Every `insurer` 상실 code in force on `on`, for a picker.
    pub fn loss_codes_on(
        &self,
        insurer: Insurer,
        on: Date,
    ) -> impl Iterator<Item = &InsuranceLossCode> {
        self.loss_codes.iter().filter(move |c| {
            c.insurer == insurer && in_force(c.effective_from, c.effective_to_exclusive, on)
        })
    }
}

fn in_force(from: Date, to_exclusive: Option<Date>, on: Date) -> bool {
    on >= from && to_exclusive.is_none_or(|to| on < to)
}

type SpanKey = (String, Option<Insurer>);

fn reject_overlaps(
    spans: impl Iterator<Item = (SpanKey, Date, Option<Date>)>,
) -> Result<(), KernelError> {
    let mut spans: Vec<_> = spans.collect();
    if let Some((key, ..)) = spans
        .iter()
        .find(|(_, from, to)| to.is_some_and(|to| to <= *from))
    {
        return Err(KernelError::validation(format!(
            "statutory row {key:?} ends before it starts"
        )));
    }
    spans.sort();
    for pair in spans.windows(2) {
        if let [(key, _, to), (next_key, next_from, _)] = pair
            && key == next_key
            && to.is_none_or(|to| to > *next_from)
        {
            return Err(KernelError::validation(format!(
                "statutory rows {key:?} overlap on {next_from}"
            )));
        }
    }
    Ok(())
}

fn parse_date(s: &str) -> Result<Date, KernelError> {
    let mut p = s.split('-');
    let bad = || KernelError::validation("invalid register date");
    let y = p.next().and_then(|v| v.parse().ok()).ok_or_else(bad)?;
    let m: u8 = p.next().and_then(|v| v.parse().ok()).ok_or_else(bad)?;
    let d = p.next().and_then(|v| v.parse().ok()).ok_or_else(bad)?;
    if p.next().is_some() {
        return Err(bad());
    }
    Date::from_calendar_date(y, m.try_into().map_err(|_| bad())?, d).map_err(|_| bad())
}
